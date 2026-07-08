/**
 * OpenBao (or HashiCorp Vault) KV v2 secret store over plain fetch — the
 * needed surface (AppRole login, kv read/write/delete) is tiny.
 *
 * Auth: a static BAO_TOKEN (dev) or AppRole (BAO_ROLE_ID + BAO_SECRET_ID,
 * production; the lease is renewed by re-login when it nears expiry).
 * Values are cached in memory for ≤5 minutes and never logged.
 */

import type { BaoConfig } from "../config.js";
import type { SecretRef, SecretStore } from "./store.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const LOGIN_SLACK_MS = 30 * 1000;

interface CachedValue {
  value: string;
  expiresAt: number;
}

export class OpenBaoStore implements SecretStore {
  private readonly cache = new Map<string, CachedValue>();
  private clientToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly config: BaoConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async login(): Promise<string> {
    if (this.config.token) return this.config.token;
    const now = Date.now();
    if (this.clientToken && now < this.tokenExpiresAt - LOGIN_SLACK_MS) {
      return this.clientToken;
    }
    const response = await this.fetchImpl(`${this.config.addr}/v1/auth/approle/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role_id: this.config.roleId, secret_id: this.config.secretId }),
    });
    if (!response.ok) {
      throw new Error(`OpenBao AppRole login failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      auth?: { client_token?: string; lease_duration?: number };
    };
    const token = body.auth?.client_token;
    if (!token) throw new Error("OpenBao AppRole login: no client_token in response");
    this.clientToken = token;
    this.tokenExpiresAt = now + (body.auth?.lease_duration ?? 3600) * 1000;
    return token;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.login();
    return this.fetchImpl(`${this.config.addr}/v1/${this.config.mount}/${path}`, {
      method,
      headers: {
        "X-Vault-Token": token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async get(ref: SecretRef): Promise<string> {
    const cacheKey = `${ref.path}#${ref.field}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    const response = await this.request("GET", `data/${ref.path}`);
    if (response.status === 404) {
      throw new Error(`Secret "${ref.path}" not found in OpenBao mount "${this.config.mount}"`);
    }
    if (!response.ok) {
      throw new Error(`OpenBao read of "${ref.path}" failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: { data?: Record<string, unknown> } };
    const value = body.data?.data?.[ref.field];
    if (typeof value !== "string" || value === "") {
      throw new Error(`Secret "${ref.path}" has no field "${ref.field}"`);
    }
    this.cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /** Merge-write one field, preserving the secret's other fields. */
  async put(path: string, field: string, value: string): Promise<void> {
    const existingResponse = await this.request("GET", `data/${path}`);
    let data: Record<string, unknown> = {};
    if (existingResponse.ok) {
      const body = (await existingResponse.json()) as { data?: { data?: Record<string, unknown> } };
      data = body.data?.data ?? {};
    }
    data[field] = value;
    const response = await this.request("POST", `data/${path}`, { data });
    if (!response.ok) {
      throw new Error(`OpenBao write to "${path}" failed: HTTP ${response.status}`);
    }
    this.cache.delete(`${path}#${field}`);
  }

  async delete(path: string): Promise<void> {
    const response = await this.request("DELETE", `metadata/${path}`);
    if (!response.ok && response.status !== 404) {
      throw new Error(`OpenBao delete of "${path}" failed: HTTP ${response.status}`);
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${path}#`)) this.cache.delete(key);
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.fetchImpl(`${this.config.addr}/v1/sys/health`);
      const body = (await response.json()) as { initialized?: boolean; sealed?: boolean };
      if (body.sealed) return { ok: false, detail: "sealed" };
      if (!body.initialized) return { ok: false, detail: "uninitialized" };
      await this.login();
      return { ok: true, detail: `connected to ${this.config.addr} (mount "${this.config.mount}")` };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }
}
