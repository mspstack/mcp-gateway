/**
 * Static bearer-token authentication — generalized port of mcp-itglue's
 * src/auth/tokens.ts. Tokens are configured via MCP_TOKENS_<ROLE> env vars
 * (parsed in config.ts); comparison is timing-safe.
 */

import { timingSafeEqual } from "node:crypto";
import type { StaticTokenEntry } from "../config.js";

/** Constant-time string comparison among equal-length candidates. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) return undefined;
  return parts[1];
}

/** Resolve a presented token to its entry, or null when nothing matches. */
export function authenticateStaticToken(
  authorizationHeader: string | undefined,
  entries: StaticTokenEntry[]
): StaticTokenEntry | null {
  const presented = bearerToken(authorizationHeader);
  if (!presented) return null;
  for (const entry of entries) {
    if (safeEquals(entry.token, presented)) return entry;
  }
  return null;
}
