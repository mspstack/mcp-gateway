/**
 * The resolved identity of a request. A session id never carries privilege:
 * every request re-authenticates and must resolve to the same principal key
 * the session was created with (mcp-itglue's binding model, generalized).
 */

export interface Principal {
  kind: "static" | "oidc" | "dev";
  /** Stable identity: static → token label; oidc → `${iss}|${sub}`; dev → "dev". */
  subject: string;
  /** Human-readable, for logs (never a secret). */
  label: string;
  roleId: number;
  roleName: string;
  isAdmin: boolean;
}

export const principalKey = (p: Principal): string => `${p.kind}:${p.subject}:${p.roleId}`;
