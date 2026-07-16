import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { Repo } from "../db/repo.js";
import {
  authorizationServerMetadata,
  mintAccessToken,
  mintAuthorizationCode,
  pkceChallengeMatches,
  RateLimiter,
  redeemAuthorizationCode,
  redirectUriAllowed,
  registerClient,
  verifyAccessToken,
} from "./authz-server.js";

const fresh = () => new Repo(openDatabase(":memory:"));

const PUBLIC_URL = "https://gw.example";
const SECRET = "unit-test-jwt-secret-0123456789";

describe("authorizationServerMetadata", () => {
  it("advertises code + S256 + public clients rooted at the public URL", () => {
    const meta = authorizationServerMetadata(PUBLIC_URL);
    expect(meta.issuer).toBe(PUBLIC_URL);
    expect(meta.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

describe("redirectUriAllowed", () => {
  it("allows https anywhere and http only on loopback", () => {
    expect(redirectUriAllowed("https://client.example/cb")).toBe(true);
    expect(redirectUriAllowed("http://localhost:33418/cb")).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:9000/cb")).toBe(true);
    expect(redirectUriAllowed("http://[::1]:9000/cb")).toBe(true);
    expect(redirectUriAllowed("http://evil.example/cb")).toBe(false);
    expect(redirectUriAllowed("custom-scheme://cb")).toBe(false);
    expect(redirectUriAllowed("not a url")).toBe(false);
  });
});

describe("registerClient", () => {
  it("registers a public client and persists it", () => {
    const repo = fresh();
    const result = registerClient(repo, {
      redirect_uris: ["http://127.0.0.1:9000/cb"],
      client_name: "Claude Code",
      token_endpoint_auth_method: "none",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = repo.oauthClient(result.clientId)!;
    expect(stored.clientName).toBe("Claude Code");
    expect(stored.redirectUris).toEqual(["http://127.0.0.1:9000/cb"]);
  });

  it("rejects missing/forbidden redirect_uris and confidential clients", () => {
    const repo = fresh();
    expect(registerClient(repo, {}).ok).toBe(false);
    expect(registerClient(repo, { redirect_uris: [] }).ok).toBe(false);
    expect(registerClient(repo, { redirect_uris: ["http://evil.example/cb"] }).ok).toBe(false);
    const confidential = registerClient(repo, {
      redirect_uris: ["https://ok.example/cb"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(confidential.ok).toBe(false);
    if (!confidential.ok) expect(confidential.error).toBe("invalid_client_metadata");
  });
});

describe("authorization codes + PKCE", () => {
  const verifier = "test-verifier-test-verifier-test-verifier-43chars";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const pending = {
    clientId: "c1",
    redirectUri: "http://127.0.0.1:9000/cb",
    codeChallenge: challenge,
    state: "xyz",
    resource: `${PUBLIC_URL}/mcp`,
  };
  const principal = { iss: "https://login.example/t/v2.0", sub: "oid-123" };

  it("mints a code redeemable exactly once with the right verifier", () => {
    const repo = fresh();
    const code = mintAuthorizationCode(repo, pending, principal);

    const wrongVerifier = redeemAuthorizationCode(repo, { code, clientId: "c1", codeVerifier: "wrong" });
    expect(wrongVerifier.ok).toBe(false); // and this consumed the code (single-use)

    const code2 = mintAuthorizationCode(repo, pending, principal);
    const wrongClient = redeemAuthorizationCode(repo, { code: code2, clientId: "other", codeVerifier: verifier });
    expect(wrongClient.ok).toBe(false);

    const code3 = mintAuthorizationCode(repo, pending, principal);
    const good = redeemAuthorizationCode(repo, { code: code3, clientId: "c1", codeVerifier: verifier });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.principal).toEqual(principal);

    // replay of a redeemed code
    const replay = redeemAuthorizationCode(repo, { code: code3, clientId: "c1", codeVerifier: verifier });
    expect(replay.ok).toBe(false);
  });

  it("rejects expired codes", () => {
    const repo = fresh();
    const code = mintAuthorizationCode(repo, pending, principal, Date.now() - 120_000);
    expect(redeemAuthorizationCode(repo, { code, clientId: "c1", codeVerifier: verifier }).ok).toBe(false);
  });

  it("pkceChallengeMatches follows RFC 7636 S256", () => {
    expect(pkceChallengeMatches(verifier, challenge)).toBe(true);
    expect(pkceChallengeMatches("nope", challenge)).toBe(false);
  });
});

describe("gateway access tokens", () => {
  const identity = { iss: "https://login.example/t/v2.0", sub: "oid-123" };

  it("round-trips identity through mint + verify", async () => {
    const token = await mintAccessToken(identity, PUBLIC_URL, SECRET);
    expect(await verifyAccessToken(token, PUBLIC_URL, SECRET)).toEqual(identity);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintAccessToken(identity, PUBLIC_URL, "other-secret-other-secret");
    await expect(verifyAccessToken(token, PUBLIC_URL, SECRET)).rejects.toThrow();
  });

  it("rejects a token minted for a different resource/issuer", async () => {
    const token = await mintAccessToken(identity, "https://other.example", SECRET);
    await expect(verifyAccessToken(token, PUBLIC_URL, SECRET)).rejects.toThrow();
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit per window, then blocks until the window rolls", () => {
    const limiter = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.allow("ip", t0)).toBe(true);
    expect(limiter.allow("ip", t0 + 1)).toBe(true);
    expect(limiter.allow("ip", t0 + 2)).toBe(true);
    expect(limiter.allow("ip", t0 + 3)).toBe(false);
    expect(limiter.allow("other", t0 + 3)).toBe(true); // per-key
    expect(limiter.allow("ip", t0 + 60_001)).toBe(true); // window rolled
  });
});
