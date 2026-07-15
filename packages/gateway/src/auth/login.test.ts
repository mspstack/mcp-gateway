/**
 * Interactive-login tests. Two seams are exercised without a live IdP:
 *   1. the signed-cookie helpers (sign/verify round-trip, tamper, expiry), and
 *   2. the callback → session → principal path, with a FAKE LoginService that
 *      returns a fixed identity (the openid-client exchange is the one part we
 *      don't own; everything after it — upsert, role persist, cookie mint,
 *      cookie-session resolution — is real).
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
import type { OidcIdentity } from "./oidc.js";
import { createApp } from "../http/app.js";
import {
  mintSessionCookieValue,
  readSessionClaims,
  mintTransientCookieValue,
  readTransientState,
  signCookiePayload,
  verifyCookiePayload,
  safeReturnTo,
  type LoginService,
  type TransientState,
} from "./login.js";

const SECRET = "unit-test-session-secret-0123456789";

describe("signed cookie helpers", () => {
  it("session cookie round-trips and rejects tampering", () => {
    const value = mintSessionCookieValue({ iss: "https://idp/", sub: "user-1" }, SECRET);
    expect(readSessionClaims(value, SECRET)).toEqual({ iss: "https://idp/", sub: "user-1" });
    // wrong secret → null
    expect(readSessionClaims(value, "other-secret-0123456789")).toBeNull();
    // flipped last char of the signature → null
    const tampered = value.slice(0, -1) + (value.at(-1) === "a" ? "b" : "a");
    expect(readSessionClaims(tampered, SECRET)).toBeNull();
    // garbage → null
    expect(readSessionClaims("not-a-cookie", SECRET)).toBeNull();
    expect(readSessionClaims(undefined, SECRET)).toBeNull();
  });

  it("rejects an expired payload (past maxAge)", () => {
    const value = signCookiePayload({ iss: "https://idp/", sub: "user-1" }, SECRET);
    // valid within a generous window, invalid with a 0ms window
    expect(verifyCookiePayload(value, SECRET, 60_000)).not.toBeNull();
    expect(verifyCookiePayload(value, SECRET, -1)).toBeNull();
  });

  it("transient PKCE state round-trips with all fields", () => {
    const t: TransientState = { codeVerifier: "v", nonce: "n", state: "s", returnTo: "/me" };
    const value = mintTransientCookieValue(t, SECRET);
    expect(readTransientState(value, SECRET)).toEqual(t);
    expect(readTransientState(value, "wrong-secret-0123456789")).toBeNull();
  });

  it("safeReturnTo only allows local absolute paths", () => {
    expect(safeReturnTo("/admin", "/me")).toBe("/admin");
    expect(safeReturnTo("//evil.com", "/me")).toBe("/me");
    expect(safeReturnTo("https://evil.com", "/me")).toBe("/me");
    expect(safeReturnTo("/a\\b", "/me")).toBe("/me");
    expect(safeReturnTo(undefined, "/me")).toBe("/me");
    expect(safeReturnTo(["/x", "/y"], "/me")).toBe("/x");
  });
});

// ── callback → session → principal (fake IdP) ───────────────────────────────

const ISS = "https://idp.test/";
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
  publicUrl: "http://localhost",
  configPath: "unused",
  dbPath: ":memory:",
  allowedOrigins: [],
  upstreamsFromFile: [],
  staticTokens: [],
  oidc: { issuer: ISS, audience: "gateway-aud", groupsClaim: "groups" },
  login: {
    clientId: "login-client",
    clientSecret: "login-secret",
    redirectUri: "http://localhost/auth/callback",
    sessionSecret: SECRET,
  },
  adminBootstrapSubjects: [],
  devAllowUnauthenticated: false,
  bao: null,
  keyVault: null,
  mode: "standalone",
};

// A fake LoginService: startAuth mints deterministic transient state; the
// identity returned by completeAuth is swapped per-test.
let nextIdentity: OidcIdentity;
const loginService: LoginService = {
  async startAuth(returnTo) {
    return {
      redirectUrl: "https://idp.test/authorize?fake=1",
      transient: { codeVerifier: "cv", nonce: "no", state: "st", returnTo },
    };
  },
  async completeAuth() {
    return nextIdentity;
  },
};

let httpServer: HttpServer;
let base: string;
let repo: Repo;
let editorRoleId: number;

beforeAll(async () => {
  repo = new Repo(openDatabase(":memory:"));
  editorRoleId = repo.roleByName("editor")!.id;
  // Map an Entra group to the editor role so a login carrying that group resolves.
  repo.setGroupMapping(ISS, "grp-editors", editorRoleId);
  const manager = new UpstreamManager([upstreamSpec], () => fakeLink);
  await manager.start();
  const app = createApp({
    config,
    repo,
    manager,
    policy: new PolicyService(repo),
    secretStore: null,
    oidcVerifier: null,
    loginService,
    adminUiDir: null,
  });
  httpServer = app.listen(0);
  base = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  httpServer.close();
});

/** Extract a single cookie's `name=value` from a response's Set-Cookie list. */
function cookieFrom(res: Response, name: string): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const first = raw.split(";")[0]!;
    if (first.startsWith(`${name}=`)) return first;
  }
  return null;
}

describe("interactive login callback → cookie session", () => {
  it("GET /auth/login sets a transient cookie and 302s to the IdP", async () => {
    const res = await fetch(`${base}/auth/login?returnTo=/me`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://idp.test/authorize?fake=1");
    expect(cookieFrom(res, "mspstack_login")).toBeTruthy();
  });

  it("callback establishes a session; the cookie then resolves a principal for /api/me", async () => {
    nextIdentity = { iss: ISS, sub: "oid-editor", email: "editor@test", groups: ["grp-editors"] };

    // Start → capture transient cookie.
    const start = await fetch(`${base}/auth/login?returnTo=/me`, { redirect: "manual" });
    const transient = cookieFrom(start, "mspstack_login")!;

    // Callback → should mint a session cookie and redirect to returnTo.
    const cb = await fetch(`${base}/auth/callback?code=abc&state=st`, {
      redirect: "manual",
      headers: { Cookie: transient },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/me");
    const session = cookieFrom(cb, "mspstack_session");
    expect(session).toBeTruthy();

    // The role was persisted at callback time.
    expect(repo.userBySubject(ISS, "oid-editor")?.roleId).toBe(editorRoleId);

    // The session cookie now authenticates /api/me (no bearer token at all).
    const access = await fetch(`${base}/api/me/access`, { headers: { Cookie: session! } });
    expect(access.status).toBe(200);
    const body = (await access.json()) as { principal: { role: string }; servers: unknown[] };
    expect(body.principal.role).toBe("editor");
    expect(body.servers.length).toBe(1);
  });

  it("a tampered session cookie authenticates no one (401 on /api/me)", async () => {
    const good = mintSessionCookieValue({ iss: ISS, sub: "oid-editor" }, SECRET);
    const tampered = good.slice(0, -2) + "xy";
    const res = await fetch(`${base}/api/me/access`, {
      headers: { Cookie: `mspstack_session=${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  it("a valid cookie for a user with no role → 403 (identity without privilege)", async () => {
    nextIdentity = { iss: ISS, sub: "oid-norole", email: "norole@test", groups: [] };
    const start = await fetch(`${base}/auth/login?returnTo=/me`, { redirect: "manual" });
    const transient = cookieFrom(start, "mspstack_login")!;
    const cb = await fetch(`${base}/auth/callback?code=abc&state=st`, {
      redirect: "manual",
      headers: { Cookie: transient },
    });
    const session = cookieFrom(cb, "mspstack_session")!;
    // Cookie is valid (identity established) but no role maps → 403, not 401.
    const res = await fetch(`${base}/api/me/access`, { headers: { Cookie: session } });
    expect(res.status).toBe(403);
  });

  it("callback without a transient cookie is a 400 (state cannot be verified)", async () => {
    const res = await fetch(`${base}/auth/callback?code=abc&state=st`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});
