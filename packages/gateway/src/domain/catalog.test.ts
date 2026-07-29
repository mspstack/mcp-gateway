import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildCatalog, derivedGroupOf, exposedNameFor, exposedTools, tierOf } from "./catalog.js";

const tool = (name: string, annotations?: Tool["annotations"]): Tool => ({
  name,
  inputSchema: { type: "object" },
  ...(annotations ? { annotations } : {}),
});

describe("tierOf", () => {
  it("derives tiers from annotations like mcp-itglue's roles.ts", () => {
    expect(tierOf({ readOnlyHint: true })).toBe("read");
    expect(tierOf({ destructiveHint: true })).toBe("destructive");
    expect(tierOf({ destructiveHint: false })).toBe("write");
    expect(tierOf({})).toBe("write");
    expect(tierOf(undefined)).toBe("write");
  });

  it("readOnlyHint wins over destructiveHint", () => {
    expect(tierOf({ readOnlyHint: true, destructiveHint: true })).toBe("read");
  });
});

describe("derivedGroupOf", () => {
  it("prefers _meta.group / _meta.toolset (the family servers' own tagging)", () => {
    expect(derivedGroupOf({ ...tool("cw_search_tickets"), _meta: { group: "tickets" } })).toBe("tickets");
    expect(derivedGroupOf({ ...tool("cw_list_my_time"), _meta: { toolset: "time" } })).toBe("time");
    // _meta wins over a description prefix
    expect(
      derivedGroupOf({ ...tool("x"), description: "[Ignored] doc", _meta: { group: "finance" } })
    ).toBe("finance");
  });

  it("falls back to a bracketed description prefix (CIPP) and its first segment", () => {
    expect(derivedGroupOf({ ...tool("ListUsers"), description: "[Identity > Administration > Users] list" })).toBe("Identity");
    expect(derivedGroupOf({ ...tool("ListStandards"), description: "[Tenant > Standards] list" })).toBe("Tenant");
  });

  it("returns null when there is nothing to derive", () => {
    expect(derivedGroupOf(tool("plain"))).toBeNull();
    expect(derivedGroupOf({ ...tool("plain"), description: "no brackets here" })).toBeNull();
    expect(derivedGroupOf({ ...tool("plain"), _meta: { group: "  " } })).toBeNull();
  });
});

describe("exposedNameFor", () => {
  it("prefixes the namespace", () => {
    expect(exposedNameFor("demo", "echo")).toBe("demo_echo");
  });

  it("does not double-prefix family tools that already carry it", () => {
    expect(exposedNameFor("itglue", "itglue_list_organizations")).toBe(
      "itglue_list_organizations"
    );
  });
});

describe("buildCatalog", () => {
  it("routes exposed names back to upstream tool names", () => {
    const { entries, collisions } = buildCatalog([
      { upstreamId: "itglue", namespace: "itglue", tools: [tool("itglue_get_document")] },
      { upstreamId: "everything", namespace: "demo", tools: [tool("echo")] },
    ]);
    expect(collisions).toEqual([]);
    expect(entries.get("itglue_get_document")?.upstreamToolName).toBe("itglue_get_document");
    expect(entries.get("demo_echo")).toMatchObject({
      upstreamId: "everything",
      upstreamToolName: "echo",
    });
  });

  it("first upstream wins on collision and the loss is reported", () => {
    const { entries, collisions } = buildCatalog([
      { upstreamId: "first", namespace: "ns", tools: [tool("echo")] },
      { upstreamId: "second", namespace: "ns", tools: [tool("ns_echo")] },
    ]);
    expect(entries.get("ns_echo")?.upstreamId).toBe("first");
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toContain('"ns_echo"');
  });

  it("exposedTools renames without mutating the source tool", () => {
    const source = tool("echo", { readOnlyHint: true });
    const { entries } = buildCatalog([{ upstreamId: "e", namespace: "demo", tools: [source] }]);
    const listed = exposedTools(entries);
    expect(listed[0]?.name).toBe("demo_echo");
    expect(listed[0]?.annotations?.readOnlyHint).toBe(true);
    expect(source.name).toBe("echo");
  });
});
