import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../db/index.js";
import { Repo } from "../db/repo.js";
import type { CatalogEntry } from "./catalog.js";
import { PolicyService, tierAllowed, toolAllowed } from "./policy.js";

describe("tierAllowed", () => {
  it("orders none < read < write < destructive", () => {
    expect(tierAllowed("none", "read")).toBe(false);
    expect(tierAllowed("read", "read")).toBe(true);
    expect(tierAllowed("read", "write")).toBe(false);
    expect(tierAllowed("write", "read")).toBe(true);
    expect(tierAllowed("write", "destructive")).toBe(false);
    expect(tierAllowed("destructive", "destructive")).toBe(true);
  });
});

describe("toolAllowed", () => {
  const base = { toolEnabled: true, effectiveTier: "write" as const, maxTier: "write" as const, override: null };

  it("allows when tier fits and tool is enabled", () => {
    expect(toolAllowed(base)).toBe(true);
  });

  it("disabled tool is never allowed, even with an allow override", () => {
    expect(toolAllowed({ ...base, toolEnabled: false, override: "allow" })).toBe(false);
  });

  it("deny override always wins over tier", () => {
    expect(toolAllowed({ ...base, override: "deny" })).toBe(false);
  });

  it("allow override rescues an insufficient tier", () => {
    expect(toolAllowed({ ...base, maxTier: "read", override: "allow" })).toBe(true);
    expect(toolAllowed({ ...base, maxTier: "read" })).toBe(false);
  });
});

describe("PolicyService (against a real repo)", () => {
  const tool = (name: string, annotations?: Tool["annotations"]): Tool => ({
    name,
    inputSchema: { type: "object" },
    ...(annotations ? { annotations } : {}),
  });
  const entry = (upstreamToolName: string, tier: "read" | "write" | "destructive"): CatalogEntry => ({
    upstreamId: "up1",
    namespace: "ns",
    upstreamToolName,
    exposedName: `ns_${upstreamToolName}`,
    tier,
    tool: tool(upstreamToolName),
  });

  function setup() {
    const repo = new Repo(openDatabase(":memory:"));
    const policy = new PolicyService(repo);
    const viewer = repo.roleByName("viewer")!;
    const editor = repo.roleByName("editor")!;
    const admin = repo.roleByName("admin")!;
    return { repo, policy, viewer, editor, admin };
  }

  it("seeded roles gate by default tier", () => {
    const { policy, viewer, editor, admin } = setup();
    const read = entry("get_doc", "read");
    const write = entry("update_doc", "write");
    const destroy = entry("delete_doc", "destructive");

    expect(policy.allows(viewer.id, read)).toBe(true);
    expect(policy.allows(viewer.id, write)).toBe(false);
    expect(policy.allows(editor.id, write)).toBe(true);
    expect(policy.allows(editor.id, destroy)).toBe(false);
    expect(policy.allows(admin.id, destroy)).toBe(true);
  });

  it("per-upstream grant overrides the role default", () => {
    const { repo, policy, editor } = setup();
    repo.setGrant(editor.id, "up1", "read"); // demote editor on this upstream
    expect(policy.allows(editor.id, entry("update_doc", "write"))).toBe(false);
    expect(policy.allows(editor.id, entry("get_doc", "read"))).toBe(true);
  });

  it("admin tier override on a tool changes its effective tier", () => {
    const { repo, policy, viewer } = setup();
    const e = entry("delete_section", "destructive");
    expect(policy.allows(viewer.id, e)).toBe(false);
    repo.upsertToolSetting({ upstreamId: "up1", toolName: "delete_section", tierOverride: "read" });
    expect(policy.allows(viewer.id, e)).toBe(true);
  });

  it("disabling a tool hides it from everyone, including admin", () => {
    const { repo, policy, admin } = setup();
    const e = entry("get_doc", "read");
    expect(policy.allows(admin.id, e)).toBe(true);
    repo.upsertToolSetting({ upstreamId: "up1", toolName: "get_doc", enabled: false });
    expect(policy.allows(admin.id, e)).toBe(false);
  });

  it("per-tool deny/allow overrides beat tiers; visibleEntries filters", () => {
    const { repo, policy, viewer } = setup();
    const read = entry("get_doc", "read");
    const write = entry("update_doc", "write");
    repo.setOverride(viewer.id, "up1", "get_doc", "deny");
    repo.setOverride(viewer.id, "up1", "update_doc", "allow");
    const visible = policy.visibleEntries(viewer.id, [read, write]).map((e) => e.upstreamToolName);
    expect(visible).toEqual(["update_doc"]);
  });

  it("unknown role sees nothing", () => {
    const { policy } = setup();
    expect(policy.allows(9999, entry("get_doc", "read"))).toBe(false);
  });
});
