import { describe, expect, it } from "vitest";
import { MemorySecretStore } from "./memory.js";
import { parseSecretRef, resolveInjectionRecord, resolveInjectionValue } from "./store.js";

describe("parseSecretRef", () => {
  it("parses bao:path#field", () => {
    expect(parseSecretRef("bao:upstreams/itglue#token")).toEqual({
      path: "upstreams/itglue",
      field: "token",
    });
  });

  it("rejects malformed refs", () => {
    for (const bad of ["bao:", "bao:path", "bao:#field", "nope"]) {
      expect(() => parseSecretRef(bad)).toThrow();
    }
  });
});

describe("resolveInjectionValue", () => {
  const env = { MY_TOKEN: "env-value" } as NodeJS.ProcessEnv;

  it("resolves bao: refs from the store", async () => {
    const store = new MemorySecretStore();
    await store.put("upstreams/itglue", "token", "s3cret");
    await expect(
      resolveInjectionValue("bao:upstreams/itglue#token", env, store, "ctx")
    ).resolves.toBe("s3cret");
  });

  it("resolves ${VAR} from env", async () => {
    await expect(resolveInjectionValue("Bearer ${MY_TOKEN}", env, null, "ctx")).resolves.toBe(
      "Bearer env-value"
    );
  });

  it("fails a bao: ref when no store is configured", async () => {
    await expect(resolveInjectionValue("bao:a#b", env, null, "ctx")).rejects.toThrow(/BAO_ADDR/);
  });

  it("resolves whole records", async () => {
    const store = new MemorySecretStore();
    await store.put("p", "f", "v");
    await expect(
      resolveInjectionRecord({ a: "bao:p#f", b: "plain", c: "${MY_TOKEN}" }, env, store, "ctx")
    ).resolves.toEqual({ a: "v", b: "plain", c: "env-value" });
  });
});
