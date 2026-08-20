/**
 * One pooled MCP client connection per upstream, with supervision.
 *
 * HTTP upstreams get credential headers injected on every request via
 * requestInit (constant for the connection's lifetime, which satisfies the
 * principal-binding check the mcp-itglue family enforces). No Origin header
 * is sent, so server-to-server requests pass those servers' origin checks.
 *
 * stdio upstreams are spawned as child processes with injected env; env
 * values never appear in argv, so `ps` cannot leak them.
 *
 * Header/env values are resolved at connect time from `${VAR}` env refs or
 * `bao:path#field` secret refs — resolved values live only in this process's
 * memory. The inbound client's identity NEVER flows here (anti-passthrough).
 *
 * Supervision: when the transport drops unexpectedly, the connection
 * reconnects with exponential backoff (1s → 60s) until it succeeds or is
 * closed; `onRecovered` lets the manager re-run discovery afterwards.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamSpec } from "../config.js";
import {
  resolveInjectionRecord,
  resolveInjectionValue,
  type SecretStore,
} from "../secrets/store.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Re-mint an OAuth2 upstream token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

/**
 * The upstream forgot our streamable-HTTP session while the local transport
 * still looks healthy — servers answer 404 (spec: "re-initialize") when they
 * restart or expire sessions server-side. The message fallback catches the
 * same condition when a proxy or wrapper re-throws it untyped.
 */
const isStaleSession = (err: unknown): boolean => {
  if (err instanceof StreamableHTTPError && err.code === 404) return true;
  return /unknown or expired mcp session|session not found/i.test(
    err instanceof Error ? err.message : String(err)
  );
};

export interface UpstreamStatus {
  connected: boolean;
  lastError: string | null;
  reconnectAttempts: number;
}

export class UpstreamConnection {
  readonly spec: UpstreamSpec;
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** When the current connection's minted OAuth2 token goes stale (0 = n/a). */
  private tokenExpiresAt = 0;
  private status: UpstreamStatus = { connected: false, lastError: null, reconnectAttempts: 0 };

  /** Fires when the upstream announces its tool list changed. */
  onToolListChanged: (() => void) | null = null;
  /** Fires after an automatic reconnect succeeds (manager re-runs discovery). */
  onRecovered: (() => void) | null = null;

  constructor(
    spec: UpstreamSpec,
    private readonly secretStore: SecretStore | null = null,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.spec = spec;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  getStatus(): UpstreamStatus {
    return { ...this.status, connected: this.connected };
  }

  /** Connect (or join an in-flight connect). Serialized so reconnects never race. */
  async connect(): Promise<void> {
    // A minted OAuth2 token is fixed for the transport's lifetime, so a stale
    // one means the whole connection must be rebuilt with a fresh token.
    if (this.client && this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt) {
      console.error(`[upstream:${this.spec.id}] access token expiring — reconnecting with a fresh one`);
      await this.dropClient();
    }
    if (this.client) return;
    if (this.closed) throw new Error(`upstream "${this.spec.id}" is closed`);
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /**
   * Client-credentials exchange for upstreams that want a minted token rather
   * than a static credential. The secret itself comes from the store/env like
   * any other injected value; only the resulting header is added, and neither
   * the secret nor the token is ever logged.
   */
  private async withMintedToken(headers: Record<string, string>): Promise<Record<string, string>> {
    const auth = this.spec.auth;
    this.tokenExpiresAt = 0;
    if (!auth) return headers;

    const clientSecret = await resolveInjectionValue(
      auth.clientSecret,
      this.env,
      this.secretStore,
      `upstream "${this.spec.id}".auth.clientSecret`
    );
    const response = await fetch(auth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: auth.clientId,
        client_secret: clientSecret,
        scope: auth.scope,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { error?: string; error_description?: string };
        // error_description can be long but carries no secret — trim it.
        detail = ` ${body.error ?? ""}${body.error_description ? `: ${body.error_description.slice(0, 200)}` : ""}`;
      } catch {
        // non-JSON error body
      }
      throw new Error(`token request failed (${response.status})${detail}`);
    }
    const token = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!token.access_token) throw new Error("token response carried no access_token");
    this.tokenExpiresAt = Date.now() + (token.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS;
    console.error(
      `[upstream:${this.spec.id}] minted access token via client credentials (expires in ${token.expires_in ?? 3600}s)`
    );
    return { ...headers, [auth.header]: `${auth.prefix}${token.access_token}` };
  }

  /** Tear down the live client without triggering the reconnect supervisor. */
  private async dropClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.onclose = undefined;
    await client.close().catch(() => undefined);
  }

  private async doConnect(): Promise<void> {
    const context = `upstream "${this.spec.id}"`;
    try {
      const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION });

      let transport;
      if (this.spec.transport === "http") {
        const url = await resolveInjectionValue(
          this.spec.url,
          this.env,
          this.secretStore,
          `${context}.url`
        );
        const headers = await this.withMintedToken(
          await resolveInjectionRecord(
            this.spec.headers,
            this.env,
            this.secretStore,
            `${context}.headers`
          )
        );
        transport = new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers },
        });
      } else {
        const injectedEnv = await resolveInjectionRecord(
          this.spec.env,
          this.env,
          this.secretStore,
          `${context}.env`
        );
        transport = new StdioClientTransport({
          command: this.spec.command,
          args: this.spec.args,
          env: { ...getDefaultEnvironment(), ...injectedEnv },
        });
      }

      await client.connect(transport);

      client.onclose = () => {
        if (this.client === client) {
          this.client = null;
          console.error(`[upstream:${this.spec.id}] connection closed`);
          this.scheduleReconnect();
        }
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.onToolListChanged?.();
      });

      this.client = client;
      this.backoffMs = BACKOFF_INITIAL_MS;
      this.status = { connected: true, lastError: null, reconnectAttempts: 0 };
      console.error(`[upstream:${this.spec.id}] connected (${this.spec.transport})`);
    } catch (err) {
      this.status = {
        connected: false,
        lastError: String(err),
        reconnectAttempts: this.status.reconnectAttempts,
      };
      throw err;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.status.reconnectAttempts += 1;
    console.error(
      `[upstream:${this.spec.id}] reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.status.reconnectAttempts})`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect()
        .then(() => this.onRecovered?.())
        .catch((err) => {
          console.error(`[upstream:${this.spec.id}] reconnect failed: ${String(err)}`);
          this.scheduleReconnect();
        });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * List all tools, following pagination. Same stale-session recovery as
   * `callTool`: an upstream that restarted answers 404 for our forgotten
   * session while the local transport still looks healthy, and without a retry
   * discovery would throw, the manager would omit the upstream, and every one of
   * its tools would drop out of the catalog until someone bounced it by hand.
   */
  async listTools(): Promise<Tool[]> {
    const client = await this.requireClient();
    try {
      return await this.collectTools(client);
    } catch (err) {
      if (this.connected && !isStaleSession(err)) {
        throw err; // upstream answered with a real error — not a session problem
      }
      console.error(
        this.connected
          ? `[upstream:${this.spec.id}] tool discovery hit an expired upstream session — re-initializing`
          : `[upstream:${this.spec.id}] tool discovery hit a dropped connection — retrying once`
      );
      if (this.connected) await this.resetClient();
      const fresh = await this.requireClient();
      return await this.collectTools(fresh);
    }
  }

  private async collectTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Call a tool. If the transport dropped (upstream restart, lost HTTP
   * session) or the upstream expired our session server-side (404 per the
   * MCP spec), re-initialize and retry exactly once.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.requireClient();
    try {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (err) {
      if (this.connected && !isStaleSession(err)) {
        throw err; // upstream answered with an error — not a session/transport problem
      }
      if (this.connected) {
        console.error(
          `[upstream:${this.spec.id}] call "${name}" hit an expired upstream session — re-initializing`
        );
        await this.resetClient();
      } else {
        console.error(
          `[upstream:${this.spec.id}] call "${name}" hit a dropped connection — retrying once`
        );
      }
      const fresh = await this.requireClient();
      return (await fresh.callTool({ name, arguments: args })) as CallToolResult;
    }
  }

  /** Drop the pooled client so the next call initializes a fresh session. */
  private async resetClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      client.onclose = undefined; // deliberate reset — no backoff reconnect
      await client.close().catch(() => undefined);
    }
  }

  private async requireClient(): Promise<Client> {
    if (!this.client) await this.connect();
    if (!this.client) throw new Error(`upstream "${this.spec.id}" is not connected`);
    return this.client;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }
}
