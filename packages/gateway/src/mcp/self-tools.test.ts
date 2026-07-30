/**
 * Self-management toolset: the admin gate (list AND call), what the tools
 * actually change, and that server specs never leak credential values.
 */

import { describe, expect, it } from "vitest";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../db/index.js";
import { Repo } from "../db/repo.js";
import { PolicyService } from "../domain/policy.js";
import { UpstreamManager, type UpstreamLink } from "../upstream/manager.js";
import { BUILTIN_PRESETS } from "../domain/presets.js";
import { loadConfig, parseUpstreamSpec, ConfigError } from "../config.js";
import type { GatewayConfig, UpstreamSpec } from "../config.js";
import type { Principal } from "../auth/principal.js";
import { callSelfTool, isSelfTool, SELF_TOOLS, type SelfToolDeps } from "./self-tools.js";

const spec: UpstreamSpec = {
  id: "fake",
  namespace: "fake",
  transport: "http",
  url: "http://unused/mcp",
  headers: { Authorization: "Bearer literal-secret-value", "x-ref": "kv:some-secret", "x-env": "${SOME_VAR}" },
  enabled: true,
} as UpstreamSpec;

const tools: Tool[] = [
  { name: "get_thing", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, description: "[Docs] read it" },
  { name: "set_thing", inputSchema: { type: "object" }, description: "[Docs] write it" },
  { name: "nuke_thing", inputSchema: { type: "object" }, annotations: { destructiveHint: true }, description: "[Admin] remove it" },
];

const link: UpstreamLink = {
  spec,
  onToolListChanged: null,
  onRecovered: null,
  async connect() {},
  async listTools() {
    return tools;
  },
  async callTool() {
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};

async function setup() {
  const repo = new Repo(openDatabase(":memory:"));
  repo.upsertUpstream(spec, "api");
  const manager = new UpstreamManager([spec], () => link);
  await manager.start();
  const config: GatewayConfig = loadConfig(["--transport", "http"], {
    MCP_TOKENS_ADMIN: "root:tok",
    DB_PATH: ":memory:",
  } as NodeJS.ProcessEnv);
  let broadcasts = 0;
  const deps: SelfToolDeps = {
    config,
    repo,
    manager,
    policy: new PolicyService(repo),
    presets: BUILTIN_PRESETS,
    onPolicyChanged: () => {
      broadcasts += 1;
    },
  };
  const admin: Principal = { kind: "static", subject: "root", label: "root", roleId: repo.roleByName("admin")!.id, roleName: "admin", isAdmin: true };
  const viewer: Principal = { kind: "static", subject: "alice", label: "alice", roleId: repo.roleByName("viewer")!.id, roleName: "viewer", isAdmin: false };
  return { repo, manager, deps, admin, viewer, broadcasts: () => broadcasts };
}

const body = (result: CallToolResult | null): string =>
  String((result?.content?.[0] as { text?: string } | undefined)?.text ?? "");
const parsed = (result: CallToolResult | null): Record<string, unknown> => JSON.parse(body(result));

describe("self-tool registry", () => {
  it("names every tool under the reserved gw_ namespace", () => {
    expect(SELF_TOOLS.length).toBeGreaterThan(8);
    for (const tool of SELF_TOOLS) {
      expect(tool.name.startsWith("gw_")).toBe(true);
      expect(isSelfTool(tool.name)).toBe(true);
    }
    expect(isSelfTool("fake_get_thing")).toBe(false);
  });

  it("reserves the gw namespace so an upstream cannot shadow the tools", () => {
    expect(() =>
      parseUpstreamSpec({ id: "x", namespace: "gw", transport: "http", url: "http://x/mcp" })
    ).toThrow(ConfigError);
  });
});

describe("admin gate", () => {
  it("refuses non-admins with the same text an unknown tool gets", async () => {
    const { deps, viewer } = await setup();
    const result = await callSelfTool(deps, viewer, "gw_status", {});
    expect(result?.isError).toBe(true);
    expect(body(result)).toContain("is not available to this session");
    expect(body(result)).toContain("may not exist"); // no existence oracle
  });

  it("returns null for names that aren't ours, so federation still runs", async () => {
    const { deps, admin } = await setup();
    expect(await callSelfTool(deps, admin, "fake_get_thing", {})).toBeNull();
  });
});

describe("read-only tools", () => {
  it("gw_status reports the catalog and upstreams", async () => {
    const { deps, admin } = await setup();
    const status = parsed(await callSelfTool(deps, admin, "gw_status", {}));
    expect(status.toolCount).toBe(3);
    expect((status.upstreams as Array<{ id: string }>).map((u) => u.id)).toEqual(["fake"]);
  });

  it("gw_list_servers redacts literal credential values but shows refs", async () => {
    const { deps, admin } = await setup();
    const servers = parsed(await callSelfTool(deps, admin, "gw_list_servers", {})) as unknown as Array<{
      headers: Record<string, string>;
    }>;
    const headers = servers[0]!.headers;
    expect(headers.Authorization).toBe("(literal, redacted)");
    expect(headers.Authorization).not.toContain("literal-secret-value");
    expect(headers["x-ref"]).toBe("ref kv:some-secret");
    expect(headers["x-env"]).toBe("env ${SOME_VAR}");
  });

  it("gw_list_tools filters by tier and summarises by group", async () => {
    const { deps, admin } = await setup();
    const reads = parsed(await callSelfTool(deps, admin, "gw_list_tools", { tier: "read" }));
    expect(reads.total).toBe(1);

    const groups = parsed(await callSelfTool(deps, admin, "gw_list_tools", { groupsOnly: true })) as unknown as {
      groups: Array<{ group: string; total: number }>;
    };
    // groups derive from the "[Docs]" / "[Admin]" description prefixes
    expect(groups.groups.map((g) => `${g.group}:${g.total}`).sort()).toEqual(["Admin:1", "Docs:2"]);
  });
});

describe("mutating tools", () => {
  it("gw_set_tools_enabled disables a whole tier and notifies sessions", async () => {
    const { deps, admin, repo, broadcasts } = await setup();
    const result = await callSelfTool(deps, admin, "gw_set_tools_enabled", {
      upstreamId: "fake",
      tier: "write",
      enabled: false,
    });
    expect(body(result)).toContain("Disabled 1 tool(s)");
    expect(repo.toolSetting("fake", "set_thing")?.enabled).toBe(false);
    expect(repo.toolSetting("fake", "get_thing")?.enabled ?? true).toBe(true);
    expect(broadcasts()).toBe(1);
  });

  it("gw_set_tools_enabled reports a miss instead of silently doing nothing", async () => {
    const { deps, admin } = await setup();
    const result = await callSelfTool(deps, admin, "gw_set_tools_enabled", {
      upstreamId: "fake",
      group: "Nope",
      enabled: false,
    });
    expect(result?.isError).toBe(true);
    expect(body(result)).toContain("Nothing matched");
  });

  it("gw_set_tool_tier raises and clears an override, and rejects unknown tools", async () => {
    const { deps, admin, repo } = await setup();
    await callSelfTool(deps, admin, "gw_set_tool_tier", { upstreamId: "fake", toolName: "get_thing", tier: "destructive" });
    expect(repo.toolSetting("fake", "get_thing")?.tierOverride).toBe("destructive");

    await callSelfTool(deps, admin, "gw_set_tool_tier", { upstreamId: "fake", toolName: "get_thing", tier: null });
    expect(repo.toolSetting("fake", "get_thing")?.tierOverride).toBeNull();

    const bad = await callSelfTool(deps, admin, "gw_set_tool_tier", { upstreamId: "fake", toolName: "ghost", tier: "read" });
    expect(bad?.isError).toBe(true);
  });

  it("gw_set_grant resolves the role by name and rejects unknown names", async () => {
    const { deps, admin, repo } = await setup();
    await callSelfTool(deps, admin, "gw_set_grant", { roleName: "viewer", upstreamId: "fake", maxTier: "none" });
    expect(repo.grantFor(repo.roleByName("viewer")!.id, "fake")).toBe("none");

    const bad = await callSelfTool(deps, admin, "gw_set_grant", { roleName: "ghosts", upstreamId: "fake", maxTier: "read" });
    expect(bad?.isError).toBe(true);
    expect(body(bad)).toContain("existing roles");
  });

  it("gw_remove_server refuses without confirm, then cascades", async () => {
    const { deps, admin, repo } = await setup();
    repo.upsertToolSetting({ upstreamId: "fake", toolName: "get_thing", enabled: false });

    const refused = await callSelfTool(deps, admin, "gw_remove_server", { upstreamId: "fake", confirm: false });
    expect(refused?.isError).toBe(true);
    expect(repo.getUpstream("fake")).not.toBeNull();

    await callSelfTool(deps, admin, "gw_remove_server", { upstreamId: "fake", confirm: true });
    expect(repo.getUpstream("fake")).toBeNull();
    expect(repo.toolSetting("fake", "get_thing")).toBeNull();
  });

  it("gw_install_preset dry-runs without saving, then installs with grants", async () => {
    const { deps, admin, repo } = await setup();
    const params = { url: "https://itglue.example/mcp", token: "kv:itglue-token" };

    const dry = parsed(await callSelfTool(deps, admin, "gw_install_preset", { presetId: "itglue", params, dryRun: true }));
    expect(dry.dryRun).toBe(true);
    expect(repo.getUpstream("itglue")).toBeNull();

    const done = parsed(await callSelfTool(deps, admin, "gw_install_preset", { presetId: "itglue", params }));
    expect(done.installed).toBe("itglue");
    expect(done.grants).toEqual(["viewer=read", "editor=write"]);
    expect(repo.getUpstream("itglue")).not.toBeNull();
  });

  it("gw_install_preset surfaces a missing required parameter", async () => {
    const { deps, admin } = await setup();
    const result = await callSelfTool(deps, admin, "gw_install_preset", { presetId: "itglue", params: {} });
    expect(result?.isError).toBe(true);
    expect(body(result)).toContain("Missing required parameter");
  });

  it("gw_backup_now explains itself when no database handle was wired", async () => {
    const { deps, admin } = await setup();
    const result = await callSelfTool(deps, admin, "gw_backup_now", {});
    expect(result?.isError).toBe(true);
    expect(body(result)).toContain("No database handle");
  });
});
