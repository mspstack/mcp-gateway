/** In-memory SecretStore for tests and BAO-less development. */

import type { SecretRef, SecretStore } from "./store.js";

export class MemorySecretStore implements SecretStore {
  readonly scheme = "bao" as const;
  private readonly secrets = new Map<string, Map<string, string>>();

  refFor(path: string, field: string): string {
    return `bao:${path}#${field}`;
  }

  async get(ref: SecretRef): Promise<string> {
    const value = this.secrets.get(ref.path)?.get(ref.field);
    if (value === undefined) {
      throw new Error(`Secret "${ref.path}" has no field "${ref.field}"`);
    }
    return value;
  }

  async put(path: string, field: string, value: string): Promise<void> {
    const existing = this.secrets.get(path) ?? new Map<string, string>();
    existing.set(field, value);
    this.secrets.set(path, existing);
  }

  async delete(path: string): Promise<void> {
    this.secrets.delete(path);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "in-memory store" };
  }
}
