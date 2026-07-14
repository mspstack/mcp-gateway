import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { KeyVaultStore, type KeyVaultClientLike } from "./keyvault.js";
import { isSecretRef, parseSecretRef, resolveInjectionValue, schemeOf } from "./store.js";

class FakeKvClient implements KeyVaultClientLike {
  store = new Map<string, string>();
  getCalls = 0;
  async getSecret(name: string): Promise<{ value?: string }> {
    this.getCalls++;
    if (!this.store.has(name)) {
      const err = new Error(`Secret not found: ${name}`) as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return { value: this.store.get(name)! };
  }
  async setSecret(name: string, value: string): Promise<void> {
    this.store.set(name, value);
  }
  async beginDeleteSecret(name: string): Promise<void> {
    if (!this.store.has(name)) {
      const err = new Error(`Secret not found: ${name}`) as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    this.store.delete(name);
  }
}

const VAULT = "https://example-kv.vault.azure.net";

describe("kv: ref parsing", () => {
  it("recognizes kv: refs alongside bao:", () => {
    expect(isSecretRef("kv:gw-upstream-itglue-token")).toBe(true);
    expect(isSecretRef("bao:upstreams/itglue#token")).toBe(true);
    expect(isSecretRef("plain-value")).toBe(false);
    expect(schemeOf("kv:x")).toBe("kv");
    expect(schemeOf("bao:x#y")).toBe("bao");
  });

  it("parses kv:name into a fieldless ref", () => {
    expect(parseSecretRef("kv:gw-upstream-itglue-token")).toEqual({
      path: "gw-upstream-itglue-token",
      field: "",
    });
  });

  it("rejects kv refs with invalid KV name characters", () => {
    expect(() => parseSecretRef("kv:has/slash")).toThrow(/kv:secret-name/);
    expect(() => parseSecretRef("kv:has_underscore")).toThrow(/kv:secret-name/);
    expect(() => parseSecretRef("kv:")).toThrow(/kv:secret-name/);
  });
});

describe("KeyVaultStore", () => {
  let client: FakeKvClient;
  let store: KeyVaultStore;

  beforeEach(() => {
    client = new FakeKvClient();
    store = new KeyVaultStore(VAULT, client);
  });
  afterEach(() => vi.useRealTimers());

  it("reads a secret by flat name", async () => {
    client.store.set("gw-upstream-itglue-token", "s3cr3t");
    await expect(store.get(parseSecretRef("kv:gw-upstream-itglue-token"))).resolves.toBe("s3cr3t");
  });

  it("caches reads for 5 minutes, then refetches", async () => {
    vi.useFakeTimers();
    client.store.set("gw-a", "v1");
    const ref = parseSecretRef("kv:gw-a");
    await store.get(ref);
    await store.get(ref);
    expect(client.getCalls).toBe(1);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await store.get(ref);
    expect(client.getCalls).toBe(2);
  });

  it("maps 404 to a clear error naming the vault", async () => {
    await expect(store.get(parseSecretRef("kv:gw-missing"))).rejects.toThrow(
      `Secret "gw-missing" not found in Key Vault ${VAULT}`
    );
  });

  it("rejects empty-valued secrets", async () => {
    client.store.set("gw-empty", "");
    await expect(store.get(parseSecretRef("kv:gw-empty"))).rejects.toThrow(/has no value/);
  });

  it("put joins path-field into the KV name and refFor round-trips", async () => {
    await store.put("gw-upstream-itglue", "token", "abc");
    expect(client.store.get("gw-upstream-itglue-token")).toBe("abc");
    const ref = store.refFor("gw-upstream-itglue", "token");
    expect(ref).toBe("kv:gw-upstream-itglue-token");
    await expect(store.get(parseSecretRef(ref))).resolves.toBe("abc");
  });

  it("put invalidates the cache for the written name", async () => {
    client.store.set("gw-b-token", "old");
    await store.get(parseSecretRef("kv:gw-b-token"));
    await store.put("gw-b", "token", "new");
    await expect(store.get(parseSecretRef("kv:gw-b-token"))).resolves.toBe("new");
  });

  it("rejects names outside the KV charset", async () => {
    await expect(store.put("bad/path", "token", "x")).rejects.toThrow(/not a valid Key Vault secret name/);
    expect(() => store.refFor("bad_name", "")).toThrow(/not a valid Key Vault secret name/);
  });

  it("delete tolerates missing secrets", async () => {
    await expect(store.delete("gw-nonexistent")).resolves.toBeUndefined();
  });

  it("health treats 404 on the probe as connected (get-only access)", async () => {
    await expect(store.health()).resolves.toEqual({ ok: true, detail: `connected to ${VAULT}` });
  });

  it("health reports auth/connectivity failures", async () => {
    client.getSecret = async () => {
      throw new Error("AADSTS700016: application not found");
    };
    const health = await store.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/AADSTS700016/);
  });
});

describe("scheme routing in resolveInjectionValue", () => {
  it("resolves kv: refs through a kv-scheme store", async () => {
    const client = new FakeKvClient();
    client.store.set("gw-x", "resolved");
    const store = new KeyVaultStore(VAULT, client);
    await expect(resolveInjectionValue("kv:gw-x", {}, store, "test")).resolves.toBe("resolved");
  });

  it("rejects bao: refs when the configured store is Key Vault", async () => {
    const store = new KeyVaultStore(VAULT, new FakeKvClient());
    await expect(resolveInjectionValue("bao:path#field", {}, store, "test")).rejects.toThrow(
      /uses a "bao:" ref but the configured secret store serves "kv:" refs/
    );
  });

  it("names both envs when no store is configured", async () => {
    await expect(resolveInjectionValue("kv:gw-x", {}, null, "test")).rejects.toThrow(
      /BAO_ADDR or KEY_VAULT_URI/
    );
  });
});
