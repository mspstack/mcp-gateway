import { describe, expect, it } from "vitest";
import type { Principal } from "../auth/principal.js";
import type { UpstreamSpec } from "../config.js";
import { identityHeaderValues } from "./gateway-server.js";

const principal: Principal = {
  kind: "oidc",
  subject: "https://login.example/t/v2.0|oid-123",
  label: "eugene@corp.example",
  roles: [{ id: 1, name: "viewer", isAdmin: false }],
  roleId: 1,
  roleName: "viewer",
  isAdmin: false,
};

const spec = (identityHeaders?: UpstreamSpec["identityHeaders"]): UpstreamSpec =>
  ({
    id: "x",
    namespace: "x",
    transport: "http",
    url: "https://x/mcp",
    headers: {},
    enabled: true,
    sessionMode: "per-user",
    requirePersonalCredentials: false,
    userDefault: "on",
    ...(identityHeaders ? { identityHeaders } : {}),
  }) as UpstreamSpec;

describe("identityHeaderValues", () => {
  it("resolves email, subject and label sources", () => {
    expect(
      identityHeaderValues(
        spec({ "x-actor": "email", "x-subject": "subject", "x-label": "label" }),
        principal,
        "eugene@corp.example"
      )
    ).toEqual({
      "x-actor": "eugene@corp.example",
      "x-subject": "https://login.example/t/v2.0|oid-123",
      "x-label": "eugene@corp.example",
    });
  });

  it("falls back to the subject when no email is on file — never omits the header", () => {
    expect(identityHeaderValues(spec({ "x-actor": "email" }), principal, null)).toEqual({
      "x-actor": "https://login.example/t/v2.0|oid-123",
    });
  });

  it("returns nothing for specs without identityHeaders", () => {
    expect(identityHeaderValues(spec(), principal, "e@x")).toEqual({});
    expect(identityHeaderValues(undefined, principal, "e@x")).toEqual({});
  });
});
