/**
 * OIDC / OAuth 2.1 resource-server token validation.
 *
 * The gateway never acts as an authorization server — it validates JWTs
 * issued by the configured IdP (Entra ID or any OIDC provider):
 *   - issuer + expiry via jose jwtVerify
 *   - audience MUST match OIDC_AUDIENCE (RFC 8707 — tokens minted for other
 *     resources, e.g. Graph, are rejected)
 * jwks_uri is discovered from <issuer>/.well-known/openid-configuration and
 * the remote JWKS is cached by jose.
 */

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { OidcConfig } from "../config.js";

export interface OidcIdentity {
  iss: string;
  sub: string;
  email?: string;
  displayName?: string;
  groups: string[];
}

export interface OidcVerifier {
  verify(token: string): Promise<OidcIdentity>;
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status} from ${url}`);
  }
  const metadata = (await response.json()) as { jwks_uri?: string };
  if (!metadata.jwks_uri) throw new Error(`OIDC discovery: no jwks_uri in ${url}`);
  return metadata.jwks_uri;
}

function stringsFromClaim(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

export function identityFromPayload(payload: JWTPayload, groupsClaim: string): OidcIdentity {
  const email =
    typeof payload.email === "string"
      ? payload.email
      : typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : undefined;
  return {
    iss: String(payload.iss),
    sub: String(payload.sub),
    ...(email ? { email } : {}),
    ...(typeof payload.name === "string" ? { displayName: payload.name } : {}),
    groups: stringsFromClaim(payload[groupsClaim]),
  };
}

/**
 * Build a verifier. `getKey` is injectable for tests (jose local JWKS);
 * in production the remote JWKS is discovered lazily on first use.
 */
export function createOidcVerifier(config: OidcConfig, getKey?: JWTVerifyGetKey): OidcVerifier {
  let keyResolver: JWTVerifyGetKey | null = getKey ?? null;
  let resolving: Promise<JWTVerifyGetKey> | null = null;

  const resolveKeys = async (): Promise<JWTVerifyGetKey> => {
    if (keyResolver) return keyResolver;
    if (!resolving) {
      resolving = discoverJwksUri(config.issuer)
        .then((jwksUri) => {
          keyResolver = createRemoteJWKSet(new URL(jwksUri));
          return keyResolver;
        })
        .finally(() => {
          resolving = null;
        });
    }
    return resolving;
  };

  return {
    async verify(token: string): Promise<OidcIdentity> {
      const keys = await resolveKeys();
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
      });
      if (!payload.sub) throw new Error("token has no sub claim");
      return identityFromPayload(payload, config.groupsClaim);
    },
  };
}
