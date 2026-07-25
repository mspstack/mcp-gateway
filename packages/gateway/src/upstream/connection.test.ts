/**
 * Integration test for UpstreamConnection against a real streamable-HTTP MCP
 * server — specifically the stale-session path: the upstream expires/forgets
 * the HTTP session server-side (server restart, TTL) while the local
 * transport still looks healthy. Per the MCP spec the server answers 404 and
 * the client must re-initialize; the connection does that transparently and
 * retries the call once.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { UpstreamConnection } from "./connection.js";
import type { UpstreamSpec } from "../config.js";

/** Minimal stateful streamable-HTTP MCP server whose sessions we can expire. */
class FakeUpstream {
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private http!: HttpServer;
  initializeCount = 0;

  async start(): Promise<string> {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.writeHead(500).end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.http.listen(0, resolve));
    return `http://localhost:${(this.http.address() as AddressInfo).port}/mcp`;
  }

  /** Simulate a server-side restart/TTL: all session ids become unknown. */
  expireAllSessions(): void {
    this.sessions.clear();
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body: unknown = raw ? JSON.parse(raw) : undefined;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }

    if (req.method === "POST" && isInitializeRequest(body)) {
      this.initializeCount += 1;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => this.sessions.set(id, transport),
      });
      const mcp = new McpServer({ name: "fake-upstream", version: "0.0.0" });
      mcp.tool("ping", async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // Unknown or expired session — what real servers (and the SDK) return.
    res.writeHead(404, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "Unknown or expired MCP session. Re-initialize." })
    );
  }
}

const spec = (url: string): UpstreamSpec =>
  ({
    id: "fake",
    namespace: "fake",
    transport: "http",
    url,
    headers: {},
    enabled: true,
  }) as UpstreamSpec;

describe("UpstreamConnection — stale streamable-HTTP sessions", () => {
  const upstream = new FakeUpstream();
  let connection: UpstreamConnection;

  beforeAll(async () => {
    const url = await upstream.start();
    connection = new UpstreamConnection(spec(url));
    await connection.connect();
  });

  afterAll(async () => {
    await connection.close();
    await upstream.stop();
  });

  it("calls tools over the pooled session", async () => {
    const result = await connection.callTool("ping", {});
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect(upstream.initializeCount).toBe(1);
  });

  it("re-initializes and retries once when the upstream expired the session", async () => {
    upstream.expireAllSessions();
    const result = await connection.callTool("ping", {});
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect(upstream.initializeCount).toBe(2); // a fresh session was minted
    expect(connection.connected).toBe(true);
  });

  it("does not re-initialize for genuine tool errors", async () => {
    const result = await connection.callTool("does-not-exist", {});
    expect(result.isError).toBe(true); // the upstream's error passes through
    expect(upstream.initializeCount).toBe(2); // no needless session churn
  });
});
