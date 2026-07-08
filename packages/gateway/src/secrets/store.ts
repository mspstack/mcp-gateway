/**
 * SecretStore abstraction + injection-value resolution.
 *
 * Upstream header/env values are resolved at connect time from one of:
 *   "bao:path#field"   — a secret in the store (OpenBao KV v2)
 *   "literal ${VAR}"   — env substitution (config.ts substituteEnv)
 *
 * Secret VALUES are never persisted in SQLite, never logged (labels and
 * sha256 prefixes only), and never returned by the admin API.
 */

import { createHash } from "node:crypto";
import { substituteEnv } from "../config.js";

export interface SecretRef {
  path: string;
  field: string;
}

export interface SecretStore {
  get(ref: SecretRef): Promise<string>;
  put(path: string, field: string, value: string): Promise<void>;
  delete(path: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export const isSecretRef = (value: string): boolean => value.startsWith("bao:");

export function parseSecretRef(value: string): SecretRef {
  const match = /^bao:([^#]+)#(.+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid secret ref "${value}" — expected "bao:path#field"`);
  }
  return { path: match[1]!, field: match[2]! };
}

/** For logs: identify a secret without revealing it. */
export const secretFingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

/** Resolve one injection value (header or env var) at connect time. */
export async function resolveInjectionValue(
  value: string,
  env: NodeJS.ProcessEnv,
  store: SecretStore | null,
  context: string
): Promise<string> {
  if (isSecretRef(value)) {
    if (!store) {
      throw new Error(
        `${context} references a secret ("${value}") but no secret store is configured — set BAO_ADDR`
      );
    }
    return store.get(parseSecretRef(value));
  }
  return substituteEnv(value, env, context);
}

export async function resolveInjectionRecord(
  record: Record<string, string>,
  env: NodeJS.ProcessEnv,
  store: SecretStore | null,
  context: string
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = await resolveInjectionValue(value, env, store, `${context}.${key}`);
  }
  return resolved;
}
