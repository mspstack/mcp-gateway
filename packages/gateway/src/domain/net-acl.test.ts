import { describe, expect, it } from "vitest";
import { clientIpFrom, ipInCidrs, isValidCidr, normalizeIp } from "./net-acl.js";

describe("ipInCidrs", () => {
  it("matches bare addresses and subnets, v4 and v6", () => {
    expect(ipInCidrs("52.224.29.136", ["52.224.29.136"])).toBe(true);
    expect(ipInCidrs("52.224.29.137", ["52.224.29.136"])).toBe(false);
    expect(ipInCidrs("52.224.29.136", ["52.224.29.136/32"])).toBe(true);
    expect(ipInCidrs("172.30.6.12", ["172.30.0.0/16"])).toBe(true);
    expect(ipInCidrs("172.31.6.12", ["172.30.0.0/16"])).toBe(false);
    expect(ipInCidrs("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipInCidrs("2001:dba::1", ["2001:db8::/32"])).toBe(false);
  });

  it("does not cross families: a v4 address is not inside a v6 subnet", () => {
    expect(ipInCidrs("10.0.0.1", ["::/0"])).toBe(false);
    expect(ipInCidrs("::1", ["0.0.0.0/0"])).toBe(false);
  });

  it("treats an IPv4-mapped IPv6 address as its v4 form", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(ipInCidrs("::ffff:172.30.6.12", ["172.30.0.0/16"])).toBe(true);
  });

  it("skips unparseable entries instead of throwing, and never matches on garbage", () => {
    expect(ipInCidrs("10.0.0.1", ["not-an-ip", "10.0.0.0/8"])).toBe(true);
    expect(ipInCidrs("10.0.0.1", ["not-an-ip"])).toBe(false);
    expect(ipInCidrs("not-an-ip", ["10.0.0.0/8"])).toBe(false);
    expect(ipInCidrs("10.0.0.1", [])).toBe(false);
  });
});

describe("isValidCidr", () => {
  it("accepts addresses and subnets, rejects malformed input", () => {
    for (const good of ["1.2.3.4", "10.0.0.0/8", "::1", "2001:db8::/32"]) {
      expect(isValidCidr(good)).toBe(true);
    }
    for (const bad of ["", "1.2.3", "1.2.3.4/", "1.2.3.4/x", "10.0.0.0/8/8", "evil.example"]) {
      expect(isValidCidr(bad)).toBe(false);
    }
  });

  it("rejects an out-of-range prefix instead of clamping it", () => {
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(isValidCidr("2001:db8::/129")).toBe(false);
    expect(isValidCidr("10.0.0.0/32")).toBe(true);
    expect(isValidCidr("2001:db8::/128")).toBe(true);
  });

  it("a stray trailing slash is not a /0 wildcard", () => {
    // Number("") === 0, so a naive parser turns this typo into "allow everything".
    expect(isValidCidr("1.2.3.4/")).toBe(false);
    expect(ipInCidrs("9.9.9.9", ["1.2.3.4/"])).toBe(false);
  });
});

describe("clientIpFrom", () => {
  const SOCKET = "10.1.1.1";

  it("ignores X-Forwarded-For entirely when the deployment is not behind a proxy", () => {
    expect(clientIpFrom("52.224.29.136", SOCKET, false)).toBe(SOCKET);
  });

  it("takes the LAST X-Forwarded-For entry — the one the proxy appended", () => {
    // A client-supplied prefix must not win: only the proxy's own entry counts.
    expect(clientIpFrom("1.2.3.4, 9.9.9.9, 52.224.29.136", SOCKET, true)).toBe("52.224.29.136");
    expect(clientIpFrom(["1.2.3.4", "52.224.29.136"], SOCKET, true)).toBe("52.224.29.136");
  });

  it("strips the port Azure App Service appends", () => {
    expect(clientIpFrom("52.224.29.136:44321", SOCKET, true)).toBe("52.224.29.136");
    expect(clientIpFrom("[2001:db8::1]:443", SOCKET, true)).toBe("2001:db8::1");
    expect(clientIpFrom("2001:db8::1", SOCKET, true)).toBe("2001:db8::1");
  });

  it("falls back to the socket address when the header is absent or unusable", () => {
    expect(clientIpFrom(undefined, SOCKET, true)).toBe(SOCKET);
    expect(clientIpFrom("garbage", SOCKET, true)).toBe(SOCKET);
    expect(clientIpFrom("", SOCKET, true)).toBe(SOCKET);
  });

  it("returns null when nothing yields an IP, so callers can fail closed", () => {
    expect(clientIpFrom(undefined, null, true)).toBeNull();
    expect(clientIpFrom("garbage", "also-garbage", true)).toBeNull();
  });
});
