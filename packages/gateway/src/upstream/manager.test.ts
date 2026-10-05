import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamSpec } from "../config.js";
import { DISCOVERY_TIMEOUT_MS, UpstreamManager, type UpstreamLink } from "./manager.js";

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
  failDiscovery = false;
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
    if (this.failDiscovery) throw new Error("Unknown or expired MCP session");
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

  /**
   * #42: discovery can fail while the transport still reports connected, and
   * `connected: true, lastError: null, toolCount: 0` reads exactly like "this
   * server has no tools" — which is how an emptied catalog went unnoticed.
   */
  it("reports WHY an upstream contributed no tools, instead of looking healthy and empty", async () => {
    const link = new FakeLink(spec("everything", "demo"), [tool("echo")]);
    const { manager } = setup([link]);
    await manager.start();
    expect(manager.summaries()[0]!.toolCount).toBe(1);

    link.failDiscovery = true;
    await manager.refreshCatalog();

    const summary = manager.summaries()[0]!;
    expect(summary.toolCount).toBe(0);
    expect(summary.lastError).toMatch(/tool discovery failed/i);

    // …and the error clears once discovery works again.
    link.failDiscovery = false;
    await manager.refreshCatalog();
    expect(manager.summaries()[0]!).toMatchObject({ toolCount: 1, lastError: null });
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

  /**
   * 2026-10-05: every admin toggle awaits a refresh, and discovery walked the
   * upstreams one by one with no deadline — one hung upstream held the UI.
   */
  it("gives up on a hung upstream after the discovery budget and still serves the rest", async () => {
    vi.useFakeTimers();
    try {
      const hung = new FakeLink(spec("hung", "hung"), [tool("x")]);
      hung.connect = () => new Promise<void>(() => {}); // never settles
      const good = new FakeLink(spec("everything", "demo"), [tool("echo")]);
      const { manager } = setup([hung, good]);

      const started = manager.start();
      await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
      await started;

      expect(exposedNames(manager)).toEqual(["demo_echo"]);
      expect(manager.summaries().find((s) => s.id === "hung")!.lastError).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hand back a pass that started before an upstream was removed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new FakeLink(spec("slow", "slow"), [tool("a")]);
    const cipp = new FakeLink(spec("cipp", "cipp"), [tool("b")]);
    const { manager } = setup([slow, cipp]);
    await manager.start();
    expect(exposedNames(manager)).toEqual(["cipp_b", "slow_a"]);

    // A refresh is in flight (slow upstream) when the admin disables cipp.
    slow.connect = () => gate;
    const inFlight = manager.refreshCatalog();
    const removal = manager.removeUpstream("cipp");
    release();
    await Promise.all([inFlight, removal]);

    expect(exposedNames(manager)).toEqual(["slow_a"]);
  });
});
