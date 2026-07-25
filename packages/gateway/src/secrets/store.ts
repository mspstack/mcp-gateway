/**
 * SecretStore abstraction + injection-value resolution.
 *
 * Upstream header/env values are resolved at connect time from one of:
 *   "bao:path#field"   — a secret in OpenBao / Vault KV v2
 *   "kv:secret-name"   — a secret in Azure Key Vault (flat name→value, no fields)
 *   "literal ${VAR}"   — env substitution (config.ts substituteEnv)
 *
 * Refs may be EMBEDDED in a larger value: "Bearer bao:upstreams/x#token"
 * resolves to "Bearer <secret>". A ref token is delimited by whitespace, so
 * paths/fields must not contain spaces. When the whole value is a single ref
 * the secret is returned verbatim (no env-substitution of its contents).
 *
 * Secret VALUES are never persisted in SQLite, never logged (labels and
 * sha256 prefixes only), and never returned by the admin API.
 */

import { createHash } from "node:crypto";
import { substituteEnv } from "../config.js";

export type SecretScheme = "bao" | "kv";

export interface SecretRef {
  path: string;
  field: string;
}

export interface SecretStore {
  /** Which ref scheme this store serves ("bao:" refs vs "kv:" refs). */
  readonly scheme: SecretScheme;
  get(ref: SecretRef): Promise<string>;
  put(path: string, field: string, value: string): Promise<void>;
  delete(path: string): Promise<void>;
  /** Render the ref string that reads back what put(path, field, …) wrote. */
  refFor(path: string, field: string): string;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export const isSecretRef = (value: string): boolean =>
  value.startsWith("bao:") || value.startsWith("kv:");

export const schemeOf = (value: string): SecretScheme =>
  value.startsWith("kv:") ? "kv" : "bao";

export function parseSecretRef(value: string): SecretRef {
  if (value.startsWith("kv:")) {
    // Azure Key Vault secrets are flat name→value — no field part. Enforce the
    // KV name charset here so a bad ref fails at parse time, not inside Azure.
    const match = /^kv:([0-9A-Za-z-]{1,127})$/.exec(value);
    if (!match) {
      throw new Error(
        `Invalid secret ref "${value}" — expected "kv:secret-name" (letters, digits, dashes only)`
      );
    }
    return { path: match[1]!, field: "" };
  }
  const match = /^bao:([^#]+)#(.+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid secret ref "${value}" — expected "bao:path#field"`);
  }
  return { path: match[1]!, field: match[2]! };
}

/** For logs: identify a secret without revealing it. */
export const secretFingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

/** Resolve a single, whole-value ref against the store (with the plumbing checks). */
async function resolveRef(
  ref: string,
  store: SecretStore | null,
  context: string
): Promise<string> {
  if (!store) {
    throw new Error(
      `${context} references a secret ("${ref}") but no secret store is configured — set BAO_ADDR or KEY_VAULT_URI`
    );
  }
  const scheme = schemeOf(ref);
  if (store.scheme !== scheme) {
    throw new Error(
      `${context} uses a "${scheme}:" ref but the configured secret store serves "${store.scheme}:" refs`
    );
  }
  return store.get(parseSecretRef(ref));
}

// A ref or ${VAR} embedded in a larger string. Ref tokens use a conservative
// path/field charset (letters, digits and - _ . /) so a ref ends cleanly at
// surrounding punctuation — "Bearer bao:upstreams/x#token" or "…#token; more".
// "kv:secret-name" uses the KV charset. Matched left-to-right in a single pass
// so resolved secret contents are never re-scanned. Whole-value refs (handled
// before this) keep the broader parseSecretRef charset for back-compat.
const REF_CHARS = "A-Za-z0-9_./-";
const EMBEDDED_TOKEN = new RegExp(
  `bao:[${REF_CHARS}]+#[${REF_CHARS}]+|kv:[0-9A-Za-z-]{1,127}|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}`,
  "g"
);

/** Resolve one injection value (header or env var) at connect time. */
export async function resolveInjectionValue(
  value: string,
  env: NodeJS.ProcessEnv,
  store: SecretStore | null,
  context: string
): Promise<string> {
  // Whole value is a single ref → return the secret verbatim (its contents are
  // never treated as a ref or ${VAR}). Also the only path that errors on a
  // malformed whole-value ref such as "bao:missing-hash".
  if (isSecretRef(value)) {
    return resolveRef(value, store, context);
  }
  // Otherwise resolve any embedded refs / ${VAR}s in a single left-to-right
  // pass, splicing resolved values in without re-scanning them.
  const matches = [...value.matchAll(EMBEDDED_TOKEN)];
  if (matches.length === 0) return value;
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    const token = match[0];
    const index = match.index ?? 0;
    out += value.slice(cursor, index);
    out += token.startsWith("${")
      ? substituteEnv(token, env, context)
      : await resolveRef(token, store, context);
    cursor = index + token.length;
  }
  out += value.slice(cursor);
  return out;
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
