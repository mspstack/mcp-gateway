/**
 * One-click delegated "Connect" for per-user upstreams (userConnect in the
 * upstream spec): /me sends the browser through an Entra authorization-code +
 * PKCE flow against a PUBLIC client, and the callback stores the resulting
 * refresh token as the signed-in user's personal credential — the friendly
 * replacement for running a device-code script and pasting the token by hand.
 *
 * Entra-only (tenant parsed from the issuer, like directory.ts). The exchange
 * uses PKCE with no client secret; offline_access is enforced so a refresh
 * token always comes back. Token values are never logged and never touch
 * SQLite — the callback writes straight to the secret store.
 */

import { createHash, randomBytes } from "node:crypto";
import type { OidcConfig } from "../config.js";
import { tenantFromIssuer } from "./directory.js";

export interface ConnectStart {
  /** Entra authorize URL to 302 the browser to. */
  redirectUrl: string;
  /** PKCE verifier + state to persist in the signed transient cookie. */
  codeVerifier: string;
  state: string;
}

export interface UserConnectService {
  start(params: { clientId: string; scopes: string; redirectUri: string }): ConnectStart;
  /** Exchange the callback code for tokens; returns the refresh token. */
  exchangeCode(params: {
    clientId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<{ refreshToken: string }>;
}

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

export function createUserConnectService(
  oidc: OidcConfig,
  /** Injectable for tests. */
  fetchImpl: typeof fetch = fetch
): UserConnectService | null {
  const tenant = tenantFromIssuer(oidc.issuer);
  if (!tenant) return null;
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;

  return {
    start({ clientId, scopes, redirectUri }) {
      const codeVerifier = b64url(randomBytes(48));
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const state = b64url(randomBytes(24));
      const scope = scopes.split(/\s+/).includes("offline_access")
        ? scopes
        : `${scopes} offline_access`;
      const url = new URL(`${base}/authorize`);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { redirectUrl: url.href, codeVerifier, state };
    },

    async exchangeCode({ clientId, code, redirectUri, codeVerifier }) {
      const response = await fetchImpl(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId, // public client — PKCE is the proof, no secret
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      if (!response.ok) {
        let detail = "";
        try {
          const err = (await response.json()) as { error?: string };
          detail = err.error ?? "";
        } catch {
          // non-JSON body
        }
        console.error(`[connect] token exchange failed: ${response.status} ${detail}`);
        throw new Error("token exchange failed");
      }
      const tokens = (await response.json()) as { refresh_token?: string };
      if (!tokens.refresh_token) {
        throw new Error(
          "no refresh token returned — the app registration must allow public client flows and the scopes must include offline_access"
        );
      }
      return { refreshToken: tokens.refresh_token };
    },
  };
}
