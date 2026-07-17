import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.js";
import { BUILTIN_PRESETS, loadPresets, renderPreset, summarize } from "./presets.js";

const cwpsa = BUILTIN_PRESETS.find((p) => p.id === "cwpsa")!;
const planner = BUILTIN_PRESETS.find((p) => p.id === "planner")!;

describe("builtin presets", () => {
  it("cover the family and validate against their own schema", () => {
    expect(BUILTIN_PRESETS.map((p) => p.id).sort()).toEqual(["cwpsa", "itglue", "planner"]);
    for (const p of BUILTIN_PRESETS) {
      expect(p.grants).toEqual({ viewer: "read", editor: "write" });
    }
  });

  it("summaries omit the spec template", () => {
    const summary = summarize(cwpsa);
    expect(summary).not.toHaveProperty("spec");
    expect(summary.params[0]!.key).toBe("url");
  });
});

describe("renderPreset", () => {
  it("substitutes params and produces a valid rich spec", () => {
    const spec = renderPreset(cwpsa, { url: "https://cw.example/mcp" });
    expect(spec.transport).toBe("http");
    if (spec.transport !== "http") throw new Error("unreachable");
    expect(spec.url).toBe("https://cw.example/mcp");
    expect(spec.headers["x-cw-toolsets"]).toBe("all");
    expect(spec.sessionMode).toBe("per-user");
    expect(spec.requirePersonalCredentials).toBe(true);
    expect(spec.personalCredentials?.map((c) => c.field)).toEqual([
      "x-cw-public-key",
      "x-cw-private-key",
      "x-cw-member-id",
      "x-cw-toolsets",
    ]);
  });

  it("renders nested structures (planner userConnect clientId)", () => {
    const spec = renderPreset(planner, {
      url: "https://pl.example/mcp",
      tenantId: "tenant-1",
      connectClientId: "pub-client",
    });
    expect(spec.userConnect?.clientId).toBe("pub-client");
    if (spec.transport === "http") expect(spec.headers["x-ms-tenant-id"]).toBe("tenant-1");
  });

  it("rejects missing required params and undeclared markers", () => {
    expect(() => renderPreset(cwpsa, {})).toThrow(/Missing required parameter "url"/);
    const rogue = {
      ...cwpsa,
      spec: { ...cwpsa.spec, url: "{{mystery}}" },
    };
    expect(() => renderPreset(rogue, { url: "https://x/mcp" })).toThrow(/undeclared parameter/);
  });

  it("param values cannot smuggle an invalid spec past validation", () => {
    const preset = {
      ...cwpsa,
      spec: { ...cwpsa.spec, namespace: "{{url}}" }, // attacker-controlled namespace
    };
    expect(() => renderPreset(preset, { url: "NOT a namespace!" })).toThrow(ConfigError);
  });
});

describe("loadPresets", () => {
  it("returns builtins when the file is absent", () => {
    expect(loadPresets(join(tmpdir(), "nope", "missing.json")).length).toBe(BUILTIN_PRESETS.length);
  });

  it("merges file presets and lets the file override a builtin id", () => {
    const dir = mkdtempSync(join(tmpdir(), "presets-"));
    const file = join(dir, "mspstack.presets.json");
    writeFileSync(
      file,
      JSON.stringify({
        presets: [
          {
            id: "cwpsa",
            title: "CW (custom)",
            description: "deployment override",
            params: [],
            spec: { id: "cwpsa", namespace: "cw", transport: "http", url: "https://custom/mcp", headers: {} },
            grants: {},
          },
          {
            id: "internal-tool",
            title: "Internal",
            description: "extra",
            params: [],
            spec: { id: "internal", namespace: "internal", transport: "http", url: "https://i/mcp", headers: {} },
            grants: { viewer: "read" },
          },
        ],
      })
    );
    const merged = loadPresets(file);
    expect(merged.length).toBe(BUILTIN_PRESETS.length + 1);
    expect(merged.find((p) => p.id === "cwpsa")?.title).toBe("CW (custom)");
    expect(merged.some((p) => p.id === "internal-tool")).toBe(true);
  });

  it("rejects malformed files loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "presets-bad-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    expect(() => loadPresets(file)).toThrow(ConfigError);
    writeFileSync(file, JSON.stringify({ presets: [{ id: "x" }] }));
    expect(() => loadPresets(file)).toThrow(ConfigError);
  });
});
