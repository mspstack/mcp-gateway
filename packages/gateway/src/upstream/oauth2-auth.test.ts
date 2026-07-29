/**
 * UpstreamConnection with an `auth` block: the gateway mints its own OAuth2
 * access token (client credentials) for upstreams that expect a finished
 * bearer rather than a static credential — third-party MCP servers behind
 * Entra/Easy Auth, e.g. CIPP. Covers the mint, the secret-store lookup for
 * the client secret, and the re-mint when the token nears expiry.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { UpstreamConnection } from "./connection.js";
import { MemorySecretStore } from "../secrets/memory.js";
import type { UpstreamSpec } from "../config.js";

/**
 * One HTTP server playing both roles: the Entra-ish token endpoint
 * (POST /token) and a bearer-protected MCP upstream (POST /mcp).
 */
class FakeTokenAndUpstream {
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private http!: HttpServer;
  /** Tokens handed out, newest last. */
  readonly issued: string[] = [];
  /** Bodies posted to the token endpoint (to assert the grant shape). */
  readonly tokenRequests: URLSearchParams[] = [];
  /** expires_in for the NEXT token — lets a test make one go stale instantly. */
  nextExpiresIn = 3600;
  rejectedRequests = 0;

  async start(): Promise<string> {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => res.writeHead(500).end(String(err)));
    });
    await new Promise<void>((resolve) => this.http.listen(0, resolve));
    return `http://localhost:${(this.http.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");

    if (req.url?.startsWith("/token")) {
      this.tokenRequests.push(new URLSearchParams(raw));
      const token = `at-${this.issued.length + 1}`;
      this.issued.push(token);
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ access_token: token, expires_in: this.nextExpiresIn, token_type: "Bearer" })
      );
      return;
    }

    // MCP endpoint: only the CURRENT token is accepted (expired ones 401).
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${this.issued.at(-1)}`) {
      this.rejectedRequests += 1;
      res.writeHead(401).end("unauthorized");
      return;
    }

    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }
    if (req.method === "POST" && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => this.sessions.set(id, transport),
      });
      const mcp = new McpServer({ name: "fake-cipp", version: "0.0.0" });
      mcp.tool("ping", async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "Unknown or expired MCP session. Re-initialize." })
    );
  }
}

const spec = (base: string): UpstreamSpec =>
  ({
    id: "cipp",
    namespace: "cipp",
    transport: "http",
    url: `${base}/mcp`,
    headers: { "x-static": "kept" },
    enabled: true,
    auth: {
      kind: "oauth2-client-credentials",
      tokenUrl: `${base}/token`,
      clientId: "client-1",
      clientSecret: "bao:cipp#secret", // resolved through the secret store
      scope: "api://client-1/.default",
      header: "Authorization",
      prefix: "Bearer ",
    },
  }) as UpstreamSpec;

describe("UpstreamConnection — minted OAuth2 upstream tokens", () => {
  const upstream = new FakeTokenAndUpstream();
  let base: string;
  let store: MemorySecretStore;

  beforeAll(async () => {
    base = await upstream.start();
    store = new MemorySecretStore();
    await store.put("cipp", "secret", "s3cr3t");
  });

  afterAll(async () => {
    await upstream.stop();
  });

  it("mints a token from the client-credentials grant and calls with it", async () => {
    const connection = new UpstreamConnection(spec(base), store);
    try {
      await connection.connect();
      expect(await connection.listTools()).toHaveLength(1);
      expect((await connection.callTool("ping", {})).content).toEqual([{ type: "text", text: "pong" }]);

      const body = upstream.tokenRequests.at(-1)!;
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("client-1");
      expect(body.get("scope")).toBe("api://client-1/.default");
      // the secret came from the store, not from the spec literal
      expect(body.get("client_secret")).toBe("s3cr3t");
      expect(upstream.rejectedRequests).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it("re-mints when the token is near expiry, so calls never 401", async () => {
    upstream.nextExpiresIn = 30; // < the 60s skew ⇒ stale immediately
    const connection = new UpstreamConnection(spec(base), store);
    try {
      await connection.connect();
      const firstToken = upstream.issued.at(-1);
      const mintsAfterConnect = upstream.tokenRequests.length;

      // Next call notices the stale token, rebuilds the connection with a
      // fresh one, and still succeeds (the fake rejects superseded tokens).
      await connection.connect();
      expect(upstream.tokenRequests.length).toBe(mintsAfterConnect + 1);
      expect(upstream.issued.at(-1)).not.toBe(firstToken);
      expect((await connection.callTool("ping", {})).content).toEqual([{ type: "text", text: "pong" }]);
    } finally {
      upstream.nextExpiresIn = 3600;
      await connection.close();
    }
  });

  it("surfaces token-endpoint failures as connect errors (no silent unauthenticated connect)", async () => {
    const broken = {
      ...spec(base),
      auth: { ...(spec(base) as { auth: Record<string, unknown> }).auth, tokenUrl: `${base}/nowhere` },
    } as UpstreamSpec;
    const connection = new UpstreamConnection(broken, store);
    try {
      // /nowhere is not the token route → 401 from the MCP branch → mint fails.
      await expect(connection.connect()).rejects.toThrow(/token request failed/);
      expect(connection.connected).toBe(false);
    } finally {
      await connection.close();
    }
  });
});
