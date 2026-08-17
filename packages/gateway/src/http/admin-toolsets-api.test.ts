/**
 * The tool-sets admin API: CRUD, live match counts, the assignment preview
 * (which must not persist anything), convert-grants, explain, and the admin
 * gate.
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
import { createApp } from "./app.js";

const spec: UpstreamSpec = {
  id: "cwpsa",
  namespace: "cw",
  transport: "http",
  url: "http://unused/mcp",
  headers: {},
  enabled: true,
};

const tools: Tool[] = [
  { name: "cw_get_ticket", description: "[tickets] read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "cw_update_ticket", description: "[tickets] write", inputSchema: { type: "object" } },
  { name: "cw_get_invoice", description: "[finance] read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "cw_delete_entry", description: "[finance] nuke", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
];

const link: UpstreamLink = {
  spec,
  onToolListChanged: null,
  onRecovered: null,
  async connect() {},
  async listTools() {
    return tools;
  },
  async callTool(): Promise<CallToolResult> {
    return { content: [{ type: "text", text: "ok" }] };
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
    { token: "tok-admin", roleName: "admin", label: "root" },
    { token: "tok-viewer", roleName: "viewer", label: "alice" },
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

let server: HttpServer;
let base: string;
let repo: Repo;
let techsId: number;

beforeAll(async () => {
  repo = new Repo(openDatabase(":memory:"));
  repo.upsertUpstream(spec, "api");
  techsId = repo.createRole("techs", "write").id;
  const manager = new UpstreamManager([spec], () => link);
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
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const api = async (
  method: string,
  path: string,
  body?: unknown,
  token = "tok-admin"
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

describe("tool set CRUD and rules", () => {
  it("creates a set, reports what each rule covers, and rejects duplicates", async () => {
    const created = await api("POST", "/tool-sets", { name: "helpdesk", description: "front line" });
    expect(created.status).toBe(200);
    const setId = created.json.id as number;

    expect((await api("POST", "/tool-sets", { name: "helpdesk" })).status).toBe(409);
    expect((await api("POST", "/tool-sets", { name: "Bad Name" })).status).toBe(400);

    // a category rule matches the two ticket tools
    const rule = await api("PUT", `/tool-sets/${setId}/rules`, {
      upstreamId: "cwpsa",
      groupLabel: "tickets",
      maxTier: "write",
    });
    expect(rule.status).toBe(200);
    expect(rule.json.matchCount).toBe(2);
    expect(rule.json.sampleMatches).toContain("cw_get_ticket");

    // a typo'd category matches nothing — the count is the warning
    const typo = await api("PUT", `/tool-sets/${setId}/rules`, {
      upstreamId: "cwpsa",
      groupLabel: "tikcets",
      maxTier: "write",
    });
    expect(typo.json.matchCount).toBe(0);

    // re-saving the same selector updates rather than duplicating
    const again = await api("PUT", `/tool-sets/${setId}/rules`, {
      upstreamId: "cwpsa",
      groupLabel: "tickets",
      maxTier: "read",
    });
    expect(again.json.rule.maxTier).toBe("read");
    const rules = await api("GET", `/tool-sets/${setId}/rules`);
    expect(rules.json).toHaveLength(2);

    // unknown upstream and unknown set are 404s, not silent no-ops
    expect((await api("PUT", `/tool-sets/${setId}/rules`, { upstreamId: "nope", maxTier: "read" })).status).toBe(404);
    expect((await api("GET", "/tool-sets/9999/rules")).status).toBe(404);

    // clean up for the next test
    const ruleId = (rules.json as Array<{ id: number }>)[0]!.id;
    expect((await api("DELETE", `/tool-sets/${setId}/rules/${ruleId}`)).status).toBe(200);
    expect((await api("DELETE", `/tool-sets/${setId}`)).status).toBe(200);
  });

  it("is admin-only", async () => {
    expect((await api("GET", "/tool-sets", undefined, "tok-viewer")).status).toBe(403);
    expect((await api("POST", "/tool-sets", { name: "sneaky" }, "tok-viewer")).status).toBe(403);
  });
});

describe("assignment preview", () => {
  it("reports the blast radius without persisting anything", async () => {
    const setId = (await api("POST", "/tool-sets", { name: "tickets-only" })).json.id as number;
    await api("PUT", `/tool-sets/${setId}/rules`, { upstreamId: "cwpsa", groupLabel: "tickets", maxTier: "write" });

    // techs (write) currently sees the three non-destructive tools
    const before = repo.roleHasSets(techsId);
    expect(before).toBe(false);

    const dry = await api("PUT", `/tool-sets/${setId}/roles`, {
      roleId: techsId,
      assigned: true,
      mode: "granted",
      dryRun: true,
    });
    expect(dry.json.dryRun).toBe(true);
    expect(dry.json.before).toBe(3); // two tickets + the read invoice
    expect(dry.json.after).toBe(2); // closed world: tickets only
    expect(dry.json.lost).toBe(1);
    expect(dry.json.sampleLost).toContain("cw_get_invoice");
    // nothing was written
    expect(repo.roleHasSets(techsId)).toBe(false);

    const real = await api("PUT", `/tool-sets/${setId}/roles`, {
      roleId: techsId,
      assigned: true,
      mode: "granted",
    });
    expect(real.json.lost).toBe(1);
    expect(repo.roleHasSets(techsId)).toBe(true);

    // self-service assignment does NOT flip the closed world on its own
    const offered = (await api("POST", "/tool-sets", { name: "finance-extras" })).json.id as number;
    await api("PUT", `/tool-sets/${offered}/rules`, { upstreamId: "cwpsa", groupLabel: "finance", maxTier: "read" });
    const ss = await api("PUT", `/tool-sets/${offered}/roles`, {
      roleId: techsId,
      assigned: true,
      mode: "self-service",
    });
    // offered, not granted → the role's live surface is unchanged
    expect(ss.json.gained).toBe(0);
    expect(repo.setsOfRole(techsId).find((s) => s.id === offered)?.mode).toBe("self-service");

    // unassigning restores the legacy world
    await api("PUT", `/tool-sets/${setId}/roles`, { roleId: techsId, assigned: false });
    expect(repo.roleHasSets(techsId)).toBe(false);
  });

  it("404s an unknown role or set", async () => {
    const setId = (await api("POST", "/tool-sets", { name: "orphan" })).json.id as number;
    expect((await api("PUT", `/tool-sets/${setId}/roles`, { roleId: 9999, assigned: true })).status).toBe(404);
    expect((await api("PUT", "/tool-sets/9999/roles", { roleId: techsId, assigned: true })).status).toBe(404);
  });
});

describe("convert-grants", () => {
  it("previews one rule per live upstream, then writes and assigns them", async () => {
    const editor = repo.roleByName("editor")!;
    repo.setGrant(editor.id, "cwpsa", "read");

    const dry = await api("POST", `/roles/${editor.id}/convert-grants`, { dryRun: true });
    expect(dry.json.rules).toEqual([{ upstreamId: "cwpsa", maxTier: "read" }]);
    expect(repo.roleHasSets(editor.id)).toBe(false);

    const done = await api("POST", `/roles/${editor.id}/convert-grants`, {});
    expect(done.json.setName).toBe("editor-converted");
    expect(repo.roleHasSets(editor.id)).toBe(true);
    // running twice would need a fresh name rather than silently merging
    expect((await api("POST", `/roles/${editor.id}/convert-grants`, {})).status).toBe(409);
  });
});

describe("explain", () => {
  it("names the winning rule, and the closed world when nothing covers the tool", async () => {
    const viewer = repo.roleByName("viewer")!;
    const setId = (await api("POST", "/tool-sets", { name: "viewer-reads" })).json.id as number;
    await api("PUT", `/tool-sets/${setId}/rules`, { upstreamId: "cwpsa", groupLabel: "tickets", maxTier: "read" });
    await api("PUT", `/tool-sets/${setId}/roles`, { roleId: viewer.id, assigned: true, mode: "granted" });

    const covered = await api("GET", `/roles/${viewer.id}/explain?upstreamId=cwpsa&toolName=cw_get_ticket`);
    expect(covered.json.granted.allowed).toBe(true);
    expect(covered.json.granted.why).toContain("viewer-reads");
    expect(covered.json.hasSets).toBe(true);

    const uncovered = await api("GET", `/roles/${viewer.id}/explain?upstreamId=cwpsa&toolName=cw_get_invoice`);
    expect(uncovered.json.granted.allowed).toBe(false);
    expect(uncovered.json.granted.why).toContain("no assigned set");

    expect((await api("GET", `/roles/${viewer.id}/explain?upstreamId=cwpsa&toolName=ghost`)).status).toBe(404);
  });
});
