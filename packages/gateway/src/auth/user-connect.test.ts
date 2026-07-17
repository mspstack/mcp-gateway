import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OidcConfig } from "../config.js";
import { createUserConnectService } from "./user-connect.js";

const oidc: OidcConfig = {
  issuer: "https://login.microsoftonline.com/tenant-guid/v2.0",
  audience: "api://gw",
  groupsClaim: "groups",
};

describe("createUserConnectService", () => {
  it("is null for non-Entra issuers", () => {
    expect(createUserConnectService({ ...oidc, issuer: "https://idp.example.com" })).toBeNull();
  });

  it("start() builds a PKCE authorize URL and enforces offline_access", () => {
    const svc = createUserConnectService(oidc)!;
    const { redirectUrl, codeVerifier, state } = svc.start({
      clientId: "pub-client",
      scopes: "Tasks.ReadWrite Group.Read.All",
      redirectUri: "https://gw/me/connect/callback",
    });
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe("pub-client");
    expect(url.searchParams.get("scope")).toBe("Tasks.ReadWrite Group.Read.All offline_access");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(codeVerifier).digest("base64url")
    );
  });

  it("exchangeCode posts a secret-less PKCE exchange and returns the refresh token", async () => {
    const bodies: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = createUserConnectService(oidc, fetchImpl)!;
    const result = await svc.exchangeCode({
      clientId: "pub-client",
      code: "auth-code",
      redirectUri: "https://gw/me/connect/callback",
      codeVerifier: "verifier",
    });
    expect(result.refreshToken).toBe("rt-1");
    expect(bodies[0]!.get("grant_type")).toBe("authorization_code");
    expect(bodies[0]!.get("code_verifier")).toBe("verifier");
    expect(bodies[0]!.get("client_secret")).toBeNull();
  });

  it("fails clearly when no refresh token comes back or the exchange errors", async () => {
    const noRt = (async () => new Response(JSON.stringify({ access_token: "at" }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      createUserConnectService(oidc, noRt)!.exchangeCode({
        clientId: "c", code: "x", redirectUri: "https://gw/cb", codeVerifier: "v",
      })
    ).rejects.toThrow(/no refresh token/);

    const err = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      createUserConnectService(oidc, err)!.exchangeCode({
        clientId: "c", code: "x", redirectUri: "https://gw/cb", codeVerifier: "v",
      })
    ).rejects.toThrow(/exchange failed/);
  });
});
