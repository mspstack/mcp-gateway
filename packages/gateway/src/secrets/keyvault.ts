/**
 * Azure Key Vault secret store — the "kv:secret-name" ref scheme.
 *
 * KV secrets are flat name→value (no fields), so put(path, field, …) writes
 * the secret named `${path}-${field}` and hands back `kv:path-field` — which
 * is exactly the plan's naming convention (gw-upstream-<id>-<field>,
 * gw-user-<oid>-<upstreamId>-<field>) falling out of the API for free.
 *
 * Auth: DefaultAzureCredential — managed identity in Azure, `az login` /
 * env-var credentials in dev. The Azure SDK is loaded lazily so gateways
 * running on OpenBao never pay its import cost.
 *
 * Values are cached in memory for ≤5 minutes (mirrors openbao.ts) and never
 * logged.
 */

import type { SecretRef, SecretStore } from "./store.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

/** Azure Key Vault secret names: 1–127 chars of letters, digits, dashes. */
const KV_NAME = /^[0-9A-Za-z-]{1,127}$/;

interface CachedValue {
  value: string;
  expiresAt: number;
}

/** The narrow surface of @azure/keyvault-secrets SecretClient we use. */
export interface KeyVaultClientLike {
  getSecret(name: string): Promise<{ value?: string }>;
  setSecret(name: string, value: string): Promise<unknown>;
  beginDeleteSecret(name: string): Promise<unknown>;
}

const isNotFound = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 404;

export class KeyVaultStore implements SecretStore {
  readonly scheme = "kv" as const;
  private readonly cache = new Map<string, CachedValue>();

  constructor(
    private readonly vaultUrl: string,
    private readonly client: KeyVaultClientLike
  ) {}

  /** put(path, field) lands under this name; single-part refs use path alone. */
  private secretName(path: string, field: string): string {
    const name = field ? `${path}-${field}` : path;
    if (!KV_NAME.test(name)) {
      throw new Error(
        `"${name}" is not a valid Key Vault secret name — use letters, digits, and dashes (e.g. gw-upstream-itglue-token)`
      );
    }
    return name;
  }

  refFor(path: string, field: string): string {
    return `kv:${this.secretName(path, field)}`;
  }

  async get(ref: SecretRef): Promise<string> {
    // kv refs carry the full secret name in `path` (field is always empty).
    const name = this.secretName(ref.path, ref.field);
    const cached = this.cache.get(name);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    let secret: { value?: string };
    try {
      secret = await this.client.getSecret(name);
    } catch (err) {
      if (isNotFound(err)) {
        throw new Error(`Secret "${name}" not found in Key Vault ${this.vaultUrl}`);
      }
      throw new Error(`Key Vault read of "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof secret.value !== "string" || secret.value === "") {
      throw new Error(`Secret "${name}" in Key Vault ${this.vaultUrl} has no value`);
    }
    this.cache.set(name, { value: secret.value, expiresAt: Date.now() + CACHE_TTL_MS });
    return secret.value;
  }

  async put(path: string, field: string, value: string): Promise<void> {
    const name = this.secretName(path, field);
    await this.client.setSecret(name, value);
    this.cache.delete(name);
  }

  async delete(path: string): Promise<void> {
    const name = this.secretName(path, "");
    try {
      await this.client.beginDeleteSecret(name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    this.cache.delete(name);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    // Read a name that should not exist: a 404 proves auth + connectivity
    // while requiring only the "get" permission (list may not be granted).
    try {
      await this.client.getSecret("gw-health-probe");
      return { ok: true, detail: `connected to ${this.vaultUrl}` };
    } catch (err) {
      if (isNotFound(err)) return { ok: true, detail: `connected to ${this.vaultUrl}` };
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Boot-time factory: lazy-imports the Azure SDK only when KV is configured. */
export async function createKeyVaultStore(vaultUrl: string): Promise<KeyVaultStore> {
  const [{ SecretClient }, { DefaultAzureCredential }] = await Promise.all([
    import("@azure/keyvault-secrets"),
    import("@azure/identity"),
  ]);
  const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  return new KeyVaultStore(vaultUrl, client);
}
