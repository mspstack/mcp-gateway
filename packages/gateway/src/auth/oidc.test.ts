import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createOidcVerifier, identityFromPayload } from "./oidc.js";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "mspstack-gateway";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const getKey = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256" }] });
  const verifier = createOidcVerifier(
    { issuer: ISSUER, audience: AUDIENCE, groupsClaim: "groups" },
    getKey
  );
  const sign = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(privateKey);
  return { verifier, sign };
}

describe("createOidcVerifier", () => {
  it("accepts a valid token and extracts identity + groups", async () => {
    const { verifier, sign } = await setup();
    const token = await sign({ email: "a@b.c", name: "Alice", groups: ["g1", "g2"] });
    const identity = await verifier.verify(token);
    expect(identity).toEqual({
      iss: ISSUER,
      sub: "user-1",
      email: "a@b.c",
      displayName: "Alice",
      groups: ["g1", "g2"],
    });
  });

  it("rejects a wrong audience (RFC 8707 binding)", async () => {
    const { verifier, sign } = await setup();
    const token = await sign({}, { aud: "https://graph.microsoft.com" });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects a wrong issuer", async () => {
    const { verifier, sign } = await setup();
    const token = await sign({}, { iss: "https://evil.example.com" });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { verifier, sign } = await setup();
    const token = await sign({}, { exp: "-1m" });
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

describe("identityFromPayload", () => {
  it("falls back to preferred_username for email and tolerates string groups", () => {
    const identity = identityFromPayload(
      {
        iss: "i",
        sub: "s",
        preferred_username: "user@corp.com",
        groups: "g1 g2,g3",
      },
      "groups"
    );
    expect(identity.email).toBe("user@corp.com");
    expect(identity.groups).toEqual(["g1", "g2", "g3"]);
  });

  it("reads a custom groups claim", () => {
    const identity = identityFromPayload({ iss: "i", sub: "s", roles: ["admin-group"] }, "roles");
    expect(identity.groups).toEqual(["admin-group"]);
  });
});
