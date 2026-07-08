import { describe, expect, it, vi } from "vitest";
import { OpenBaoStore } from "./openbao.js";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("OpenBaoStore", () => {
  const config = { addr: "http://bao:8200", mount: "mspstack", token: "root" };

  it("reads a field via KV v2 and caches it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { data: { token: "s3cret", other: "x" } } })
    );
    const store = new OpenBaoStore(config, fetchImpl as unknown as typeof fetch);
    const ref = { path: "upstreams/itglue", field: "token" };
    await expect(store.get(ref)).resolves.toBe("s3cret");
    await expect(store.get(ref)).resolves.toBe("s3cret");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second read from cache
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://bao:8200/v1/mspstack/data/upstreams/itglue");
  });

  it("reports missing secrets and fields distinctly", async () => {
    const store404 = new OpenBaoStore(
      config,
      vi.fn(async () => jsonResponse(404, {})) as unknown as typeof fetch
    );
    await expect(store404.get({ path: "a", field: "b" })).rejects.toThrow(/not found/);

    const storeNoField = new OpenBaoStore(
      config,
      vi.fn(async () => jsonResponse(200, { data: { data: { other: "x" } } })) as unknown as typeof fetch
    );
    await expect(storeNoField.get({ path: "a", field: "b" })).rejects.toThrow(/no field "b"/);
  });

  it("put merges fields and invalidates the cache", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (init?.method === "GET" || init?.method === undefined) {
        return jsonResponse(200, { data: { data: { existing: "keep" } } });
      }
      return jsonResponse(200, {});
    });
    const store = new OpenBaoStore(config, fetchImpl as unknown as typeof fetch);
    await store.put("upstreams/cw", "publicKey", "pk");
    const write = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(write.init!.body as string)).toEqual({
      data: { existing: "keep", publicKey: "pk" },
    });
  });

  it("logs in via AppRole when no static token is set", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/auth/approle/login")) {
        return jsonResponse(200, { auth: { client_token: "leased", lease_duration: 3600 } });
      }
      return jsonResponse(200, { data: { data: { f: "v" } } });
    });
    const store = new OpenBaoStore(
      { addr: "http://bao:8200", mount: "mspstack", roleId: "r", secretId: "s" },
      fetchImpl as unknown as typeof fetch
    );
    await expect(store.get({ path: "p", field: "f" })).resolves.toBe("v");
    const kvCall = fetchImpl.mock.calls.find(([url]) => (url as string).includes("/data/"))!;
    expect((kvCall[1] as RequestInit).headers).toMatchObject({ "X-Vault-Token": "leased" });
  });
});
