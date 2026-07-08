import { describe, expect, it } from "vitest";
import { authenticateStaticToken, bearerToken, safeEquals } from "./static-tokens.js";

describe("safeEquals", () => {
  it("matches equal strings and rejects different ones", () => {
    expect(safeEquals("abc", "abc")).toBe(true);
    expect(safeEquals("abc", "abd")).toBe(false);
    expect(safeEquals("abc", "abcd")).toBe(false);
    expect(safeEquals("", "")).toBe(true);
  });
});

describe("bearerToken", () => {
  it("extracts well-formed Bearer tokens only", () => {
    expect(bearerToken("Bearer tok")).toBe("tok");
    expect(bearerToken("bearer tok")).toBeUndefined();
    expect(bearerToken("Bearer")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("authenticateStaticToken", () => {
  const entries = [
    { token: "tok-viewer", roleName: "viewer", label: "alice" },
    { token: "tok-admin", roleName: "admin", label: "root" },
  ];

  it("resolves a matching token to its entry", () => {
    expect(authenticateStaticToken("Bearer tok-admin", entries)?.label).toBe("root");
    expect(authenticateStaticToken("Bearer tok-viewer", entries)?.roleName).toBe("viewer");
  });

  it("returns null for unknown or missing tokens", () => {
    expect(authenticateStaticToken("Bearer nope", entries)).toBeNull();
    expect(authenticateStaticToken(undefined, entries)).toBeNull();
    expect(authenticateStaticToken("Bearer tok-admin", [])).toBeNull();
  });
});
