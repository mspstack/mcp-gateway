import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildCatalog, exposedNameFor, exposedTools, tierOf } from "./catalog.js";

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
