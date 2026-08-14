/**
 * Integration test: real Express app + real repo/policy + fake upstream.
 * Exercises the auth wiring, role-filtered tools/list, call-time policy
 * re-check, principal-bound sessions, and the admin API guard.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../db/index.js";
import { Repo } from "../db/repo.js";
import { PolicyService } from "../domain/policy.js";
import { UpstreamManager, type UpstreamLink } from "../upstream/manager.js";
import type { GatewayConfig, UpstreamSpec } from "../config.js";
import { createApp, originAllowed } from "./app.js";

const upstreamSpec: UpstreamSpec = {
  id: "fake",
  namespace: "fake",
  transport: "http",
  url: "http://unused/mcp",
  headers: {},
  enabled: true,
};

const tools: Tool[] = [
  { name: "read_thing", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "write_thing", inputSchema: { type: "object" } },
];

const fakeLink: UpstreamLink = {
  spec: upstreamSpec,
  onToolListChanged: null,
  onRecovered: null,
  async connect() {},
  async listTools() {
    return tools;
  },
  async callTool(name): Promise<CallToolResult> {
    return { content: [{ type: "text", text: `ok:${name}` }] };
  },
  async close() {},
};

const config: GatewayConfig = {
  port: 0,
  publicUrl: "http://localhost:0",
  configPath: "unused",
  dbPath: ":memory:",
  selfTools: true,
  backup: { dir: "unused", keep: 3, intervalHours: 0 },
  allowedOrigins: [],
  upstreamsFromFile: [],
  staticTokens: [
    { token: "tok-viewer", roleName: "viewer", label: "alice" },
    { token: "tok-admin", roleName: "admin", label: "root" },
  ],
  oidc: null,
  login: null,
  gatewayJwtSecret: null,
  adminBootstrapSubjects: [],
  devAllowUnauthenticated: false,
  bao: null,
  keyVault: null,
  mode: "standalone",
};

let httpServer: HttpServer;
let base: string;
let repo: Repo;

beforeAll(async () => {
  repo = new Repo(openDatabase(":memory:"));
  const manager = new UpstreamManager([upstreamSpec], () => fakeLink);
  await manager.start();
  const app = createApp({
    config,
    repo,
    manager,
    policy: new PolicyService(repo),
    secretStore: null,
    oidcVerifier: null,
    adminUiDir: null,
  });
  httpServer = app.listen(0);
  base = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  httpServer.close();
});

interface RpcReply {
  status: number;
  sessionId?: string;
  json?: { result?: Record<string, never> & { tools?: Tool[]; content?: Array<{ text: string }>; isError?: boolean } };
}

async function rpc(body: unknown, token?: string, sessionId?: string): Promise<RpcReply> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  const raw = dataLine ? dataLine.slice(5).trim() : text;
  return {
    status: response.status,
    ...(response.headers.get("mcp-session-id")
      ? { sessionId: response.headers.get("mcp-session-id")! }
      : {}),
    ...(raw ? { json: JSON.parse(raw) } : {}),
  };
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

async function initSession(token: string): Promise<string> {
  const reply = await rpc(initBody, token);
  expect(reply.status).toBe(200);
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "mcp-session-id": reply.sessionId!,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return reply.sessionId!;
}

const listTools = async (token: string, sid: string) =>
  (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token, sid)).json!.result!.tools!.map(
    (t) => t.name
  );

/** Federated tools only — admins also get the built-in gw_* self-management set. */
const listFederated = async (token: string, sid: string) =>
  (await listTools(token, sid)).filter((n) => !n.startsWith("gw_"));

describe("gateway HTTP app", () => {
  it("serves /health without auth, reporting login availability", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { login: boolean };
    expect(body.login).toBe(false); // no interactive login on this fixture
  });

  it("redirects / to /me even without interactive login", async () => {
    const response = await fetch(`${base}/`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/me");
  });

  it("rejects unauthenticated /mcp requests", async () => {
    const reply = await rpc(initBody);
    expect(reply.status).toBe(401);
  });

  it("PRM endpoint 404s when OIDC is not configured", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(404);
  });

  it("filters tools/list by role and re-checks at call time", async () => {
    const viewerSid = await initSession("tok-viewer");
    expect(await listTools("tok-viewer", viewerSid)).toEqual(["fake_read_thing"]);

    const adminSid = await initSession("tok-admin");
    expect((await listFederated("tok-admin", adminSid)).sort()).toEqual([
      "fake_read_thing",
      "fake_write_thing",
    ]);

    // viewer calling a write tool → policy stops it before the upstream
    const denied = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fake_write_thing", arguments: {} } },
      "tok-viewer",
      viewerSid
    );
    expect(denied.json?.result?.isError).toBe(true);
    expect(denied.json?.result?.content?.[0]?.text).toContain("not available");

    // and an allowed call flows through to the upstream
    const allowed = await rpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fake_read_thing", arguments: {} } },
      "tok-viewer",
      viewerSid
    );
    expect(allowed.json?.result?.content?.[0]?.text).toBe("ok:read_thing");
  });

  it("binds sessions to principals — a different token on the same session is 403", async () => {
    const sid = await initSession("tok-viewer");
    const hijack = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" }, "tok-admin", sid);
    expect(hijack.status).toBe(403);
  });

  it("disabling a tool removes it for everyone", async () => {
    repo.upsertToolSetting({ upstreamId: "fake", toolName: "read_thing", enabled: false });
    try {
      const sid = await initSession("tok-admin");
      expect(await listFederated("tok-admin", sid)).toEqual(["fake_write_thing"]);
    } finally {
      repo.upsertToolSetting({ upstreamId: "fake", toolName: "read_thing", enabled: true });
    }
  });

  it("guards the admin API by role", async () => {
    const asViewer = await fetch(`${base}/api/status`, {
      headers: { Authorization: "Bearer tok-viewer" },
    });
    expect(asViewer.status).toBe(403);

    const asAdmin = await fetch(`${base}/api/status`, {
      headers: { Authorization: "Bearer tok-admin" },
    });
    expect(asAdmin.status).toBe(200);
    const body = (await asAdmin.json()) as { upstreams: Array<{ id: string }> };
    expect(body.upstreams.map((u) => u.id)).toEqual(["fake"]);
  });
});

describe("admin directory search endpoint", () => {
  it("reports configured:false when no directory search is wired", async () => {
    const response = await fetch(`${base}/api/directory/search?q=ndr`, {
      headers: { Authorization: "Bearer tok-admin" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, results: [] });
  });

  it("is admin-only and proxies to the injected search", async () => {
    const fakeSearch = {
      async search(query: string, type: string) {
        return [{ kind: "group" as const, id: "g1", displayName: `hit:${query}:${type}`, secondary: "" }];
      },
      async namesByIds(ids: string[]) {
        return Object.fromEntries(ids.filter((id) => id === "known-guid").map((id) => [id, "Known Group"]));
      },
    };
    const app = createApp({
      config,
      repo,
      manager: new UpstreamManager([upstreamSpec], () => fakeLink),
      policy: new PolicyService(repo),
      secretStore: null,
      oidcVerifier: null,
      directorySearch: fakeSearch,
      adminUiDir: null,
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const asViewer = await fetch(`http://localhost:${port}/api/directory/search?q=ndr`, {
        headers: { Authorization: "Bearer tok-viewer" },
      });
      expect(asViewer.status).toBe(403);

      const asAdmin = await fetch(`http://localhost:${port}/api/directory/search?q=ndr&type=group`, {
        headers: { Authorization: "Bearer tok-admin" },
      });
      const body = (await asAdmin.json()) as { configured: boolean; results: Array<{ displayName: string }> };
      expect(body.configured).toBe(true);
      expect(body.results[0]?.displayName).toBe("hit:ndr:group");

      // sub-2-char query returns empty without touching the search
      const short = await fetch(`http://localhost:${port}/api/directory/search?q=n`, {
        headers: { Authorization: "Bearer tok-admin" },
      });
      expect(await short.json()).toEqual({ configured: true, results: [] });

      // group-mappings are enriched with directory display names when resolvable
      const editor = repo.roleByName("editor")!;
      repo.setGroupMapping("https://idp", "known-guid", editor.id);
      repo.setGroupMapping("https://idp", "unknown-guid", editor.id);
      try {
        const mappings = (await (
          await fetch(`http://localhost:${port}/api/group-mappings`, {
            headers: { Authorization: "Bearer tok-admin" },
          })
        ).json()) as Array<{ claimValue: string; claimLabel: string | null }>;
        expect(mappings.find((m) => m.claimValue === "known-guid")?.claimLabel).toBe("Known Group");
        expect(mappings.find((m) => m.claimValue === "unknown-guid")?.claimLabel).toBeNull();
      } finally {
        for (const m of repo.listGroupMappings()) repo.deleteGroupMapping(m.id);
      }
    } finally {
      server.close();
    }
  });
});

describe("self-management tools over MCP", () => {
  it("are offered to admins only, and a viewer's call is refused like an unknown tool", async () => {
    const adminSid = await initSession("tok-admin");
    const adminTools = await listTools("tok-admin", adminSid);
    expect(adminTools).toContain("gw_status");
    expect(adminTools).toContain("gw_set_tools_enabled");

    const viewerSid = await initSession("tok-viewer");
    const viewerTools = await listTools("tok-viewer", viewerSid);
    expect(viewerTools.some((n) => n.startsWith("gw_"))).toBe(false);

    // Hidden isn't enough — calling it anyway must fail at the boundary.
    const denied = await rpc(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "gw_status", arguments: {} } },
      "tok-viewer",
      viewerSid
    );
    expect(denied.json?.result?.isError).toBe(true);
    expect(denied.json?.result?.content?.[0]?.text).toContain("not available");
  });

  it("an admin can inspect and change the catalog conversationally", async () => {
    const sid = await initSession("tok-admin");
    const status = await rpc(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "gw_status", arguments: {} } },
      "tok-admin",
      sid
    );
    const reported = JSON.parse(status.json!.result!.content![0]!.text) as { toolCount: number };
    expect(reported.toolCount).toBe(2); // read_thing + write_thing

    const disabled = await rpc(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "gw_set_tools_enabled", arguments: { upstreamId: "fake", tier: "write", enabled: false } },
      },
      "tok-admin",
      sid
    );
    expect(disabled.json?.result?.content?.[0]?.text).toContain("Disabled 1 tool(s)");
    expect(repo.toolSetting("fake", "write_thing")?.enabled).toBe(false);

    // restore
    await rpc(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "gw_set_tools_enabled", arguments: { upstreamId: "fake", tier: "write", enabled: true } },
      },
      "tok-admin",
      sid
    );
  });
});

describe("tools/list_changed notifications", () => {
  const setPref = (body: unknown, token = "tok-viewer") =>
    fetch(`${base}/api/me/prefs`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  interface Stream {
    controller: AbortController;
    reader: ReadableStreamDefaultReader<Uint8Array>;
  }

  /**
   * Opens the session's standalone GET (SSE) stream — the only channel a
   * server-initiated notification can travel on. Retries on 409: the transport
   * allows one stream per session and an aborted one isn't reaped instantly.
   */
  async function openStream(sid: string, lastEventId?: string): Promise<Stream> {
    const controller = new AbortController();
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${base}/mcp`, {
        headers: {
          Accept: "text/event-stream",
          Authorization: "Bearer tok-viewer",
          "mcp-session-id": sid,
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
        signal: controller.signal,
      });
      if (response.status === 200) return { controller, reader: response.body!.getReader() };
      expect(response.status).toBe(409);
      if (attempt === 9) throw new Error("previous SSE stream never released");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Reads the stream until `needle` shows up; null if it doesn't in time. */
  async function readUntil(stream: Stream, needle: string, ms = 1500): Promise<string | null> {
    const timer = setTimeout(() => stream.controller.abort(), ms);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!buffer.includes(needle)) {
        const { done, value } = await stream.reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    } catch {
      return null; // aborted by the timer → nothing arrived
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * True if `action` produced a tools/list_changed on a live stream. The stream
   * is open before `action` runs, so a false is a real absence, not a race.
   * A fresh session per call keeps the 409 retry loop out of the assertions.
   */
  async function sawListChanged(action: () => Promise<unknown>): Promise<boolean> {
    const sid = await initSession("tok-viewer");
    const stream = await openStream(sid);
    try {
      await action();
      return (await readUntil(stream, "notifications/tools/list_changed")) !== null;
    } finally {
      stream.controller.abort();
    }
  }

  it("fires when the user's OWN /me switch changes their list", async () => {
    const sid = await initSession("tok-viewer");
    expect(await listTools("tok-viewer", sid)).toEqual(["fake_read_thing"]);
    try {
      // The role envelope is untouched here — only this principal's prefs
      // change — so a role-level fingerprint would skip the notification.
      const notified = await sawListChanged(() =>
        setPref({ upstreamId: "fake", toolName: "read_thing", enabled: false })
      );
      expect(notified).toBe(true);
      expect(await listTools("tok-viewer", sid)).toEqual([]);
    } finally {
      await setPref({ upstreamId: "fake", toolName: "read_thing", enabled: true });
    }
  });

  it("stays quiet when a write changes nothing the session can see", async () => {
    try {
      await setPref({ upstreamId: "fake", toolName: "read_thing", enabled: false });
      // Same pref written twice: the visible list is already empty, so the
      // diffing must swallow the second write instead of spamming clients.
      const notified = await sawListChanged(() =>
        setPref({ upstreamId: "fake", toolName: "read_thing", enabled: false })
      );
      expect(notified).toBe(false);
    } finally {
      await setPref({ upstreamId: "fake", toolName: "read_thing", enabled: true });
    }
  });

  it("buffers a notification sent while no stream is open and replays it on resume", async () => {
    const sid = await initSession("tok-viewer");
    const live = await openStream(sid);
    try {
      // 1. one delivered notification, to learn an event id to resume from
      await setPref({ upstreamId: "fake", toolName: "read_thing", enabled: false });
      const delivered = await readUntil(live, "notifications/tools/list_changed");
      expect(delivered).not.toBeNull();
      const eventId = /^id: *(.+)$/m.exec(delivered!)?.[1]?.trim();
      expect(eventId).toBeTruthy();

      // 2. the client goes away, and the list moves while it is gone — without
      //    an event store this notification would be dropped on the floor
      live.controller.abort();
      await setPref({ upstreamId: "fake", toolName: "read_thing", enabled: true });

      // 3. resuming with Last-Event-ID hands over what was missed
      const resumed = await openStream(sid, eventId);
      try {
        expect(await readUntil(resumed, "notifications/tools/list_changed")).not.toBeNull();
      } finally {
        resumed.controller.abort();
      }
    } finally {
      await setPref({ upstreamId: "fake", toolName: "read_thing", enabled: true });
    }
  });

  it("still fires for admin-side catalog changes, and only for affected sessions", async () => {
    const patch = (body: unknown) =>
      fetch(`${base}/api/catalog/fake`, {
        method: "PATCH",
        headers: { Authorization: "Bearer tok-admin", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      expect(await sawListChanged(() => patch({ enabled: false, tier: "read" }))).toBe(true);
      // write_thing is outside the viewer's envelope → their list is unchanged
      expect(await sawListChanged(() => patch({ enabled: false, tier: "write" }))).toBe(false);
    } finally {
      repo.upsertToolSetting({ upstreamId: "fake", toolName: "read_thing", enabled: true });
      repo.upsertToolSetting({ upstreamId: "fake", toolName: "write_thing", enabled: true });
    }
  });
});

describe("refused calls", () => {
  const call = (token: string, sid: string, name: string) =>
    rpc({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name, arguments: {} } }, token, sid);
  const text = (reply: RpcReply) => reply.json?.result?.content?.[0]?.text ?? "";

  it("names the caller's OWN switch, and stays vague about everything else", async () => {
    const sid = await initSession("tok-viewer");

    // role ceiling — must look exactly like an unknown tool
    const roleDenied = text(await call("tok-viewer", sid, "fake_write_thing"));
    const unknown = text(await call("tok-viewer", sid, "fake_nope"));
    expect(roleDenied).toContain("may not exist");
    expect(unknown).toContain("may not exist");
    expect(roleDenied.replace("fake_write_thing", "X")).toBe(unknown.replace("fake_nope", "X"));

    // the caller's own off-switch: say so and point at the page
    await fetch(`${base}/api/me/prefs`, {
      method: "PUT",
      headers: { Authorization: "Bearer tok-viewer", "Content-Type": "application/json" },
      body: JSON.stringify({ upstreamId: "fake", toolName: "read_thing", enabled: false }),
    });
    try {
      const own = text(await call("tok-viewer", sid, "fake_read_thing"));
      expect(own).toContain("switched off in your personal settings");
      expect(own).toContain("/me");
      expect(own).not.toContain("may not exist");
    } finally {
      await fetch(`${base}/api/me/prefs`, {
        method: "PUT",
        headers: { Authorization: "Bearer tok-viewer", "Content-Type": "application/json" },
        body: JSON.stringify({ upstreamId: "fake", toolName: "read_thing", enabled: true }),
      });
    }
  });

  it("keeps the vague wording for an admin kill switch, not the user's business", async () => {
    const sid = await initSession("tok-viewer");
    repo.upsertToolSetting({ upstreamId: "fake", toolName: "read_thing", enabled: false });
    try {
      expect(text(await call("tok-viewer", sid, "fake_read_thing"))).toContain("may not exist");
    } finally {
      repo.upsertToolSetting({ upstreamId: "fake", toolName: "read_thing", enabled: true });
    }
  });
});

describe("session reload", () => {
  const reload = (token: string) =>
    fetch(`${base}/api/me/sessions/reload`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });

  it("drops only the caller's own sessions, forcing their clients to re-initialize", async () => {
    const mine = await initSession("tok-viewer");
    const alsoMine = await initSession("tok-viewer");
    const theirs = await initSession("tok-admin");

    const response = await reload("tok-viewer");
    expect(response.status).toBe(200);
    // Every session of this principal goes, including ones earlier tests left
    // behind — the point is "all of mine", not "the two I just made".
    const body = (await response.json()) as { ok: boolean; closed: number };
    expect(body.ok).toBe(true);
    expect(body.closed).toBeGreaterThanOrEqual(2);

    // my sessions are gone — the client must handshake again
    for (const sid of [mine, alsoMine]) {
      const after = await rpc({ jsonrpc: "2.0", id: 41, method: "tools/list" }, "tok-viewer", sid);
      expect(after.status).toBe(404);
    }
    // someone else's session is untouched
    expect(await listFederated("tok-admin", theirs)).toContain("fake_read_thing");
  });

  it("shows me my own clients and whether they can be notified at all", async () => {
    const sid = await initSession("tok-viewer");
    await initSession("tok-admin"); // someone else's, must not appear

    const mine = (await (
      await fetch(`${base}/api/me/sessions`, { headers: { Authorization: "Bearer tok-viewer" } })
    ).json()) as { sessions: Array<{ sessionId: string; streamOpen: boolean }>; notificationStream: boolean };

    expect(mine.sessions.map((s) => s.sessionId)).toContain(sid);
    expect(mine.sessions.every((s) => s.streamOpen === false)).toBe(true);
    // No GET stream anywhere → the gateway cannot push list_changed at all,
    // which is what makes "Apply now" the only cure. Say so, don't imply it.
    expect(mine.notificationStream).toBe(false);
  });

  it("is admin-only on /api/sessions, and targets one session or one principal", async () => {
    const sid = await initSession("tok-viewer");

    expect((await fetch(`${base}/api/sessions`, { headers: { Authorization: "Bearer tok-viewer" } })).status).toBe(403);

    const listed = (await (
      await fetch(`${base}/api/sessions`, { headers: { Authorization: "Bearer tok-admin" } })
    ).json()) as Array<{ sessionId: string; label: string; streamOpen: boolean }>;
    expect(listed.find((s) => s.sessionId === sid)?.label).toBe("alice");
    expect(listed.find((s) => s.sessionId === sid)?.streamOpen).toBe(false);

    const post = (body: unknown) =>
      fetch(`${base}/api/sessions/reload`, {
        method: "POST",
        headers: { Authorization: "Bearer tok-admin", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    // exactly one selector, never a blanket drop
    expect((await post({})).status).toBe(400);
    expect((await post({ sessionId: sid, principal: "static:alice" })).status).toBe(400);

    const closed = (await (await post({ sessionId: sid })).json()) as { closed: number };
    expect(closed.closed).toBe(1);
    expect((await rpc({ jsonrpc: "2.0", id: 42, method: "tools/list" }, "tok-viewer", sid)).status).toBe(404);
  });
});

describe("forgetting a user", () => {
  it("removes the row and everything keyed to that identity, and 404s twice", async () => {
    const user = repo.upsertUserOnLogin({ iss: "https://idp", sub: "gone", email: "gone@test" });
    const principal = "oidc:https://idp|gone";
    repo.setUserPref(principal, "fake", "read_thing", false);
    repo.setLoginRoles(user.id, [repo.roleByName("viewer")!.id]);

    const del = async () =>
      fetch(`${base}/api/users/${user.id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer tok-admin" },
      });

    expect((await del()).status).toBe(200); // idempotent-ish: the second try 404s
    expect(repo.listUsers().some((u) => u.sub === "gone")).toBe(false);
    expect(repo.listUserPrefs(principal)).toHaveLength(0);
    expect(repo.loginRoles(user.id)).toHaveLength(0);
    expect((await del()).status).toBe(404);
  });

  it("is admin-only", async () => {
    const user = repo.upsertUserOnLogin({ iss: "https://idp", sub: "keep-me" });
    const asViewer = await fetch(`${base}/api/users/${user.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer tok-viewer" },
    });
    expect(asViewer.status).toBe(403);
    expect(repo.listUsers().some((u) => u.sub === "keep-me")).toBe(true);
  });
});

describe("bulk catalog toggle", () => {
  const bulk = (body: unknown, upstream = "fake") =>
    fetch(`${base}/api/catalog/${upstream}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer tok-admin", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("switches a whole tier, a whole server, and 404s an unknown upstream", async () => {
    // fake exposes read_thing (read, annotated) + write_thing (no annotation → write)
    const readOff = await bulk({ enabled: false, tier: "read" });
    expect(readOff.status).toBe(200);
    expect((await readOff.json()) as { changed: number }).toEqual({ ok: true, changed: 1 });
    expect(repo.toolSetting("fake", "read_thing")?.enabled).toBe(false);
    expect(repo.toolSetting("fake", "write_thing")?.enabled ?? true).toBe(true); // untouched

    // whole server (no tier) — both tools
    const allOn = await bulk({ enabled: true });
    expect((await allOn.json()) as { changed: number }).toMatchObject({ changed: 2 });
    expect(repo.toolSetting("fake", "read_thing")?.enabled).toBe(true);

    expect((await bulk({ enabled: false }, "nope")).status).toBe(404);
    // non-admins can't
    const asViewer = await fetch(`${base}/api/catalog/fake`, {
      method: "PATCH",
      headers: { Authorization: "Bearer tok-viewer", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(asViewer.status).toBe(403);
  });

  it("matches the EFFECTIVE tier, so an override moves a tool between switches", async () => {
    repo.upsertToolSetting({ upstreamId: "fake", toolName: "read_thing", tierOverride: "destructive" });
    try {
      // read switch now matches nothing; destructive matches the overridden tool
      expect((await (await bulk({ enabled: false, tier: "read" })).json()) as { changed: number }).toMatchObject({ changed: 0 });
      expect((await (await bulk({ enabled: false, tier: "destructive" })).json()) as { changed: number }).toMatchObject({ changed: 1 });
      expect(repo.toolSetting("fake", "read_thing")?.enabled).toBe(false);
    } finally {
      repo.upsertToolSetting({ upstreamId: "fake", toolName: "read_thing", tierOverride: null, enabled: true });
    }
  });
});

describe("preset install endpoint", () => {
  const preset = {
    id: "fam",
    title: "Family server",
    description: "test preset",
    params: [
      { key: "url", label: "URL", required: true, secret: false },
    ],
    spec: {
      id: "fam",
      namespace: "fam",
      transport: "http",
      url: "{{url}}",
      headers: { "x-key": "discovery-only" },
      sessionMode: "per-user",
      requirePersonalCredentials: true,
      personalCredentials: [{ field: "x-key", label: "Key", secret: true }],
    },
    grants: { viewer: "read", editor: "write", ghost: "destructive" },
  };

  it("lists, dry-runs without persisting, installs with grants, warns on unknown roles", async () => {
    const presetRepo = new Repo(openDatabase(":memory:"));
    const app = createApp({
      config,
      repo: presetRepo,
      manager: new UpstreamManager([], () => fakeLink),
      policy: new PolicyService(presetRepo),
      secretStore: null,
      oidcVerifier: null,
      presets: [preset as never],
      adminUiDir: null,
    });
    const server = app.listen(0);
    try {
      const base2 = `http://localhost:${(server.address() as AddressInfo).port}`;
      const adminApi = (path: string, init: RequestInit = {}) =>
        fetch(`${base2}/api${path}`, {
          ...init,
          headers: { Authorization: "Bearer tok-admin", "Content-Type": "application/json", ...init.headers },
        });

      // catalog (no spec template exposed)
      const catalog = (await (await adminApi("/presets")).json()) as Array<Record<string, unknown>>;
      expect(catalog[0]!.id).toBe("fam");
      expect(catalog[0]!).not.toHaveProperty("spec");

      // missing required param → 400, nothing persisted
      const missing = await adminApi("/presets/fam/install", { method: "POST", body: JSON.stringify({ params: {} }) });
      expect(missing.status).toBe(400);

      // dry run returns the rendered spec, persists nothing
      const dry = (await (
        await adminApi("/presets/fam/install", {
          method: "POST",
          body: JSON.stringify({ params: { url: "http://fam.example/mcp" }, dryRun: true }),
        })
      ).json()) as { ok: boolean; spec: { url: string; requirePersonalCredentials: boolean } };
      expect(dry.spec.url).toBe("http://fam.example/mcp");
      expect(dry.spec.requirePersonalCredentials).toBe(true);
      expect(presetRepo.getUpstream("fam")).toBeNull();

      // real install: upstream + grants for known roles, warning for the ghost
      const installed = (await (
        await adminApi("/presets/fam/install", {
          method: "POST",
          body: JSON.stringify({ params: { url: "http://fam.example/mcp" } }),
        })
      ).json()) as { ok: boolean; grants: Array<{ role: string; maxTier: string }>; warnings: string[] };
      expect(installed.ok).toBe(true);
      expect(installed.grants.map((g) => `${g.role}:${g.maxTier}`).sort()).toEqual(["editor:write", "viewer:read"]);
      expect(installed.warnings[0]).toContain('"ghost"');
      expect(presetRepo.getUpstream("fam")?.spec.personalCredentials?.[0]?.field).toBe("x-key");
      const viewer = presetRepo.roleByName("viewer")!;
      expect(presetRepo.grantFor(viewer.id, "fam")).toBe("read");

      // unknown preset id
      expect((await adminApi("/presets/nope/install", { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("originAllowed", () => {
  it("passes absent Origin and localhost; rejects malformed and unlisted", () => {
    expect(originAllowed(undefined, [])).toBe(true);
    expect(originAllowed("http://localhost:5173", [])).toBe(true);
    expect(originAllowed("null", [])).toBe(false);
    expect(originAllowed("https://evil.com", [])).toBe(false);
    expect(originAllowed("https://ok.com", ["https://ok.com"])).toBe(true);
  });
});
