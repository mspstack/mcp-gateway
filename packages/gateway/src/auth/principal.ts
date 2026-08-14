/**
 * The resolved identity of a request. A session id never carries privilege:
 * every request re-authenticates and must resolve to the same principal key
 * the session was created with (mcp-itglue's binding model, generalized).
 */

import { createHash } from "node:crypto";

export interface PrincipalRole {
  id: number;
  name: string;
  isAdmin: boolean;
}

export interface Principal {
  kind: "static" | "oidc" | "dev";
  /** Stable identity: static → token label; oidc → `${iss}|${sub}`; dev → "dev". */
  subject: string;
  /** Human-readable, for logs (never a secret). */
  label: string;
  /**
   * Every role held. The envelope is their UNION (issue #28): a user in two
   * mapped groups keeps both surfaces, because "we gave you billing access"
   * must never take ticket access away. Subtraction lives outside roles — the
   * global kill switch and the user's own /me prefs.
   */
  roles: PrincipalRole[];
  /** Primary role — most privileged, first in `roles` — for display and messages. */
  roleId: number;
  roleName: string;
  isAdmin: boolean;
}

/** Build a Principal's role fields from a "most privileged first" role list. */
export function withRoles<T extends { kind: Principal["kind"]; subject: string; label: string }>(
  base: T,
  roles: PrincipalRole[]
): T & Pick<Principal, "roles" | "roleId" | "roleName" | "isAdmin"> {
  const primary = roles[0]!;
  return {
    ...base,
    roles,
    roleId: primary.id,
    roleName: roles.length > 1 ? roles.map((r) => r.name).join("+") : primary.name,
    isAdmin: roles.some((r) => r.isAdmin),
  };
}

/** Role ids, sorted — the identity half of a session binding key. */
export const roleIdsOf = (p: Principal): number[] => p.roles.map((r) => r.id).sort((a, b) => a - b);

// A role change mid-session yields a different key, so the existing
// principal-mismatch 403 makes the client reconnect — unchanged behaviour.
export const principalKey = (p: Principal): string =>
  `${p.kind}:${p.subject}:${roleIdsOf(p).join(",")}`;

/**
 * Identity key for personal state (prefs, registered credentials) —
 * deliberately WITHOUT roleId: a role change must not orphan a user's own
 * narrowing or credentials.
 */
export const prefsIdentity = (p: Principal): string => `${p.kind}:${p.subject}`;

/**
 * Deterministic Key-Vault-safe slug for per-user secret names
 * (gw-user-<slug>-<upstreamId>-<field>). Entra OIDs are GUIDs and pass
 * through recognizably; anything else (issuer URLs, emails) is hashed so the
 * slug never leaks structure into secret names and always fits the KV charset.
 */
export function principalSlug(p: Principal): string {
  const subjectPart = p.subject.split("|").pop() ?? p.subject;
  if (/^[0-9A-Za-z-]{1,36}$/.test(subjectPart)) return subjectPart.toLowerCase();
  return createHash("sha256").update(prefsIdentity(p)).digest("hex").slice(0, 16);
}
