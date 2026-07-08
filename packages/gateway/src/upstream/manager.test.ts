import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamSpec } from "../config.js";
import { UpstreamManager, type UpstreamLink } from "./manager.js";

const spec = (id: string, namespace: string, enabled = true): UpstreamSpec => ({
  id,
  namespace,
  transport: "http",
  url: `http://localhost/${id}/mcp`,
  headers: {},
  enabled,
});

const tool = (name: string): Tool => ({ name, inputSchema: { type: "object" } });

class FakeLink implements UpstreamLink {
  onToolListChanged: (() => void) | null = null;
  onRecovered: (() => void) | null = null;
  connectCalls = 0;
  failConnect = false;
  lastCall: { name: string; args: Record<string, unknown> } | null = null;

  constructor(
    readonly spec: UpstreamSpec,
    public tools: Tool[]
  ) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failConnect) throw new Error("connection refused");
  }

  async listTools(): Promise<Tool[]> {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.lastCall = { name, args };
    return { content: [{ type: "text", text: `${this.spec.id}:${name}` }] };
  }

  async close(): Promise<void> {}
}

function setup(links: FakeLink[], extraSpecs: UpstreamSpec[] = []) {
  const bySpec = new Map(links.map((link) => [link.spec.id, link]));
  const specs = [...links.map((link) => link.spec), ...extraSpecs];
  const manager = new UpstreamManager(specs, (s) => {
    const link = bySpec.get(s.id);
    if (!link) throw new Error(`no fake for ${s.id}`);
    return link;
  });
  return { manager, bySpec };
}

const exposedNames = (manager: UpstreamManager) =>
  [...manager.catalogEntries()].map((e) => e.exposedName).sort();

describe("UpstreamManager", () => {
  it("merges namespaced tools from all upstreams", async () => {
    const { manager } = setup([
      new FakeLink(spec("itglue", "itglue"), [tool("itglue_get_document")]),
      new FakeLink(spec("everything", "demo"), [tool("echo")]),
    ]);
    await manager.start();
    expect(exposedNames(manager)).toEqual(["demo_echo", "itglue_get_document"]);
  });

  it("routes calls to the owning upstream under the original tool name", async () => {
    const demo = new FakeLink(spec("everything", "demo"), [tool("echo")]);
    const { manager } = setup([demo]);
    await manager.start();

    const entry = manager.entryFor("demo_echo")!;
    const result = await manager.callTool(entry, { message: "hi" });
    expect(demo.lastCall).toEqual({ name: "echo", args: { message: "hi" } });
    expect(result.isError).toBeUndefined();
  });

  it("returns isError text when the upstream call throws", async () => {
    const demo = new FakeLink(spec("everything", "demo"), [tool("echo")]);
    demo.callTool = async () => {
      throw new Error("boom");
    };
    const { manager } = setup([demo]);
    await manager.start();
    const result = await manager.callTool(manager.entryFor("demo_echo")!, {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("boom") }]);
  });

  it("serves healthy upstreams when another fails to connect", async () => {
    const bad = new FakeLink(spec("bad", "bad"), [tool("x")]);
    bad.failConnect = true;
    const good = new FakeLink(spec("everything", "demo"), [tool("echo")]);
    const { manager } = setup([bad, good]);
    await manager.start();
    expect(exposedNames(manager)).toEqual(["demo_echo"]);
  });

  it("skips disabled upstreams but still reports them in summaries", async () => {
    const { manager } = setup(
      [new FakeLink(spec("everything", "demo"), [tool("echo")])],
      [spec("off", "off", false)] // no fake registered — factory must not be called
    );
    await manager.start();
    expect(exposedNames(manager)).toEqual(["demo_echo"]);
    const off = manager.summaries().find((s) => s.id === "off")!;
    expect(off.enabled).toBe(false);
    expect(off.connected).toBe(false);
  });

  it("hot-adds and removes upstreams at runtime", async () => {
    const first = new FakeLink(spec("everything", "demo"), [tool("echo")]);
    const added = new FakeLink(spec("extra", "extra"), [tool("ping")]);
    const bySpec = new Map([
      ["everything", first],
      ["extra", added],
    ]);
    const manager = new UpstreamManager([first.spec], (s) => bySpec.get(s.id)!);
    await manager.start();
    expect(exposedNames(manager)).toEqual(["demo_echo"]);

    await manager.upsertUpstream(added.spec);
    expect(exposedNames(manager)).toEqual(["demo_echo", "extra_ping"]);

    await manager.removeUpstream("everything");
    expect(exposedNames(manager)).toEqual(["extra_ping"]);
  });

  it("fires onCatalogChanged only when the merged catalog actually changes", async () => {
    const demo = new FakeLink(spec("everything", "demo"), [tool("echo")]);
    const { manager } = setup([demo]);
    const changed = vi.fn();
    manager.onCatalogChanged = changed;

    await manager.start();
    expect(changed).toHaveBeenCalledTimes(1); // empty → initial catalog

    await manager.refreshCatalog();
    expect(changed).toHaveBeenCalledTimes(1); // same tools → no event

    demo.tools = [tool("echo"), tool("reverse")];
    demo.onToolListChanged?.(); // upstream announces a change
    await manager.refreshCatalog(); // joins/awaits the refresh
    expect(changed).toHaveBeenCalledTimes(2);
    expect(exposedNames(manager)).toEqual(["demo_echo", "demo_reverse"]);
  });
});
