/**
 * UpstreamManager: owns all upstream connections and the merged tool catalog.
 *
 * Upstreams can be added/removed/toggled at runtime (admin API) — the manager
 * hot-connects new ones and rebuilds the catalog. An upstream that fails to
 * connect is logged and skipped (the gateway still serves the healthy ones);
 * its supervised connection keeps retrying with backoff. Upstream
 * `tools/list_changed` notifications and reconnect recoveries trigger a
 * rediscovery; when the merged catalog actually changes, `onCatalogChanged`
 * fires so the HTTP layer can notify connected clients.
 *
 * The manager is policy-free: role filtering happens in the MCP layer via
 * PolicyService, keyed by the entries this manager exposes.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamSpec } from "../config.js";
import {
  buildCatalog,
  type CatalogEntry,
  type UpstreamTools,
} from "../domain/catalog.js";
import { UpstreamConnection, type UpstreamStatus } from "./connection.js";

/** Minimal connection surface the manager needs — lets tests inject fakes. */
export interface UpstreamLink {
  readonly spec: UpstreamSpec;
  onToolListChanged: (() => void) | null;
  onRecovered?: (() => void) | null;
  connect(): Promise<void>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
  getStatus?(): UpstreamStatus;
}

export interface UpstreamSummary {
  id: string;
  namespace: string;
  transport: "http" | "stdio";
  enabled: boolean;
  connected: boolean;
  lastError: string | null;
  toolCount: number;
}

/**
 * Separator for personal-link pool keys. A control character cannot occur in an
 * upstream id or a principal, so it cannot be spoofed into a collision - and it
 * lives here as a named constant because the same separator has to be built the
 * same way in every place that reads or writes the pool. It was not: the pool
 * was keyed with a space while the flush searched for a control character, so
 * closePersonalLinks() silently matched nothing.
 */
const PERSONAL_KEY_SEP = "\u0000";

/**
 * Per-upstream budget for connect + tools/list during a catalog refresh. One
 * slow or hung upstream used to hold every admin toggle (they all await a
 * refresh) for as long as its transport cared to wait.
 */
export const DISCOVERY_TIMEOUT_MS = 20_000;

const failure = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

export class UpstreamManager {
  private readonly links = new Map<string, UpstreamLink>();
  /** Per-principal links for sessionMode:"per-user" upstreams — key `${upstreamId}\u0000${sessionKey}`. */
  private readonly personalLinks = new Map<string, UpstreamLink>();
  private readonly specs = new Map<string, UpstreamSpec>();
  private catalog = new Map<string, CatalogEntry>();
  private refreshing: Promise<void> | null = null;
  /** A second pass requested while one was running — see refreshCatalog(). */
  private refreshQueued: Promise<void> | null = null;
  /**
   * Why an upstream contributed no tools on the last refresh. Discovery can
   * fail while the transport still reports connected, and then `connected: true,
   * lastError: null, toolCount: 0` is indistinguishable from "this server has
   * no tools" — which is how a vanished catalog goes unnoticed (#42).
   */
  private readonly discoveryErrors = new Map<string, string>();
  /** Fires after the merged catalog changed (upstream update or admin action). */
  onCatalogChanged: (() => void) | null = null;

  constructor(
    specs: UpstreamSpec[],
    private readonly linkFactory: (spec: UpstreamSpec) => UpstreamLink = (spec) =>
      new UpstreamConnection(spec)
  ) {
    for (const spec of specs) this.register(spec);
  }

  private register(spec: UpstreamSpec): void {
    this.specs.set(spec.id, spec);
    if (!spec.enabled) {
      console.error(`[gateway] upstream "${spec.id}" is disabled — not connecting`);
      return;
    }
    const link = this.linkFactory(spec);
    link.onToolListChanged = () => {
      console.error(`[upstream:${spec.id}] tool list changed — rediscovering`);
      void this.refreshCatalog();
    };
    if ("onRecovered" in link) {
      link.onRecovered = () => {
        console.error(`[upstream:${spec.id}] recovered — rediscovering`);
        void this.refreshCatalog();
      };
    }
    this.links.set(spec.id, link);
  }

  async start(): Promise<void> {
    await this.refreshCatalog();
    console.error(
      `[gateway] serving ${this.catalog.size} tool(s) from ${this.links.size} upstream(s)`
    );
  }

  /** Add or replace an upstream at runtime, then rebuild the catalog. */
  async upsertUpstream(spec: UpstreamSpec): Promise<void> {
    await this.removeUpstream(spec.id, { keepSpec: false, silent: true });
    this.register(spec);
    await this.refreshCatalog();
  }

  async removeUpstream(
    id: string,
    opts: { keepSpec?: boolean; silent?: boolean } = {}
  ): Promise<void> {
    const link = this.links.get(id);
    if (link) {
      this.links.delete(id);
      await link.close().catch(() => undefined);
    }
    await this.closePersonalLinks(id);
    this.discoveryErrors.delete(id);
    if (!opts.keepSpec) this.specs.delete(id);
    if (!opts.silent) await this.refreshCatalog();
  }

  /**
   * Drop ONE principal's pooled link to an upstream, so their next call builds a
   * fresh one with whatever credentials are registered now. Personal links are
   * memoized by upstream id + principal, and used to live until the
   * upstream itself was bounced, which meant a credential the user had just
   * rotated on /me kept being ignored (#44).
   */
  async closePersonalLink(upstreamId: string, sessionKey: string): Promise<boolean> {
    const key = `${upstreamId}${PERSONAL_KEY_SEP}${sessionKey}`;
    const link = this.personalLinks.get(key);
    if (!link) return false;
    this.personalLinks.delete(key);
    await link.close().catch(() => undefined);
    console.error(`[upstream:${upstreamId}] personal link dropped after a credential change`);
    return true;
  }

  private async closePersonalLinks(upstreamId: string): Promise<void> {
    const prefix = `${upstreamId}${PERSONAL_KEY_SEP}`;
    const closing: Promise<void>[] = [];
    for (const [key, link] of this.personalLinks) {
      if (key.startsWith(prefix)) {
        this.personalLinks.delete(key);
        closing.push(link.close().catch(() => undefined));
      }
    }
    await Promise.all(closing);
  }

  /** Reconnect-if-needed + rediscover every upstream, then rebuild the catalog. */
  async refreshCatalog(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
      return this.refreshing;
    }
    // A pass is already running, but it started before whatever change brought
    // us here (an upstream just disabled, added, replaced) — joining it would
    // hand back a catalog that still reflects the old state. Queue ONE more
    // pass after it; any number of callers arriving meanwhile share that one.
    if (!this.refreshQueued) {
      this.refreshQueued = this.refreshing.then(() => {
        this.refreshQueued = null;
        return this.refreshCatalog();
      });
    }
    return this.refreshQueued;
  }

  private async doRefresh(): Promise<void> {
    // In parallel, each under its own budget: one slow upstream no longer
    // serializes (and stalls) discovery of all the others.
    const links = [...this.links.values()];
    const results = await Promise.all(
      links.map(async (link): Promise<UpstreamTools | null> => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s`)),
            DISCOVERY_TIMEOUT_MS
          );
          timer.unref?.();
        });
        try {
          const tools = await Promise.race([
            (async () => {
              await link.connect();
              return link.listTools();
            })(),
            timeout,
          ]);
          this.discoveryErrors.delete(link.spec.id);
          return { upstreamId: link.spec.id, namespace: link.spec.namespace, tools };
        } catch (err) {
          this.discoveryErrors.set(link.spec.id, `tool discovery failed: ${String(err)}`);
          console.error(
            `[upstream:${link.spec.id}] unavailable: ${String(err)} — its tools are omitted until it recovers`
          );
          return null;
        } finally {
          clearTimeout(timer);
        }
      })
    );
    // An upstream removed or replaced while we were waiting must not have its
    // old tools written back into the catalog.
    const discovered = results.filter(
      (r, i): r is UpstreamTools => r !== null && this.links.get(r.upstreamId) === links[i]
    );

    const { entries, collisions } = buildCatalog(discovered);
    for (const collision of collisions) console.error(`[gateway] tool collision: ${collision}`);

    const before = this.fingerprint();
    this.catalog = entries;
    if (this.fingerprint() !== before) this.onCatalogChanged?.();
  }

  private fingerprint(): string {
    return [...this.catalog.keys()].sort().join("\n");
  }

  catalogEntries(): IterableIterator<CatalogEntry> {
    return this.catalog.values();
  }

  entryFor(exposedName: string): CatalogEntry | undefined {
    return this.catalog.get(exposedName);
  }

  specFor(id: string): UpstreamSpec | undefined {
    return this.specs.get(id);
  }

  summaries(): UpstreamSummary[] {
    return [...this.specs.values()].map((spec) => {
      const link = this.links.get(spec.id);
      const status = link?.getStatus?.() ?? {
        connected: false,
        lastError: null,
        reconnectAttempts: 0,
      };
      let toolCount = 0;
      for (const entry of this.catalog.values()) {
        if (entry.upstreamId === spec.id) toolCount += 1;
      }
      return {
        id: spec.id,
        namespace: spec.namespace,
        transport: spec.transport,
        enabled: spec.enabled,
        connected: link ? status.connected : false,
        // A discovery failure is reported even when the transport looks healthy.
        lastError: status.lastError ?? this.discoveryErrors.get(spec.id) ?? null,
        toolCount,
      };
    });
  }

  async callTool(
    entry: CatalogEntry,
    args: Record<string, unknown>,
    personal?: { sessionKey: string; credentialRefs: Record<string, string> }
  ): Promise<CallToolResult> {
    const link = personal ? this.personalLink(entry.upstreamId, personal) : this.links.get(entry.upstreamId);
    if (!link) {
      return failure(`Upstream "${entry.upstreamId}" is not available.`);
    }
    try {
      await link.connect();
      return await link.callTool(entry.upstreamToolName, args);
    } catch (err) {
      // Family convention: errors become isError text, never thrown to the SDK.
      return failure(`Upstream "${entry.upstreamId}" call failed: ${String(err)}`);
    }
  }

  /**
   * Lazily create/reuse the caller's own connection to a per-user upstream.
   * The spec is cloned with the caller's credential REFS layered over the
   * header/env values whose keys they registered — the refs still resolve
   * through the secret store at connect time (anti-passthrough unchanged:
   * nothing from the inbound request is forwarded, only stored secrets).
   */
  private personalLink(
    upstreamId: string,
    personal: { sessionKey: string; credentialRefs: Record<string, string> }
  ): UpstreamLink | undefined {
    const spec = this.specs.get(upstreamId);
    if (!spec || !spec.enabled) return undefined;
    const key = `${upstreamId}${PERSONAL_KEY_SEP}${personal.sessionKey}`;
    const existing = this.personalLinks.get(key);
    if (existing) return existing;

    const overlaid: UpstreamSpec =
      spec.transport === "http"
        ? { ...spec, headers: { ...spec.headers, ...personal.credentialRefs } }
        : { ...spec, env: { ...spec.env, ...personal.credentialRefs } };
    const link = this.linkFactory(overlaid);
    // Personal links serve calls only — catalog discovery stays on the shared
    // link, so their tool_list_changed notifications are irrelevant here.
    this.personalLinks.set(key, link);
    return link;
  }

  async stop(): Promise<void> {
    await Promise.all([
      ...[...this.links.values()].map((link) => link.close()),
      ...[...this.personalLinks.values()].map((link) => link.close()),
    ]);
  }
}
