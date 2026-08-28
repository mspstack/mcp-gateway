/**
 * Network ACL primitives: CIDR matching and safe client-IP extraction.
 *
 * Extraction is deliberately explicit about trust: X-Forwarded-For is only
 * consulted when the deployment SAYS it sits behind a proxy (TRUST_PROXY),
 * and then only the LAST entry counts — the one appended by that proxy.
 * Everything earlier in the list arrived from the wire and is attacker-
 * controlled. Azure App Service appends `ip:port`, so ports are stripped.
 */

import { BlockList, isIP } from "node:net";

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything else unchanged. */
export function normalizeIp(value: string): string {
  const lower = value.toLowerCase();
  if (lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4) return lower.slice(7);
  return value;
}

/** Strip `:port` from `1.2.3.4:56789` and brackets from `[::1]:8080`. */
function stripPort(value: string): string {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value;
  }
  const first = value.indexOf(":");
  // Exactly one colon → IPv4:port. More → bare IPv6, leave it alone.
  if (first !== -1 && first === value.lastIndexOf(":")) return value.slice(0, first);
  return value;
}

/**
 * The caller's address for policy decisions. `xff` is the raw
 * X-Forwarded-For header (string or repeated), `socketAddr` the TCP peer.
 * Returns null only when neither yields a parseable IP — callers treat
 * null as "deny when a binding exists" (fail closed).
 */
export function clientIpFrom(
  xff: string | string[] | undefined,
  socketAddr: string | null | undefined,
  trustProxy: boolean
): string | null {
  if (trustProxy && xff !== undefined) {
    const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    const last = raw?.split(",").pop()?.trim();
    if (last) {
      const candidate = normalizeIp(stripPort(last));
      if (isIP(candidate)) return candidate;
    }
  }
  if (socketAddr) {
    const candidate = normalizeIp(socketAddr);
    if (isIP(candidate)) return candidate;
  }
  return null;
}

interface ParsedEntry {
  addr: string;
  /** null for a bare address (exact match). */
  prefix: number | null;
  family: 4 | 6;
}

/**
 * One parser behind both the validator and the matcher, so what an admin is
 * allowed to save is exactly what the matcher understands.
 *
 * Note the empty-prefix rejection: `Number("")` is 0, so a stray trailing
 * slash ("1.2.3.4/") would otherwise parse as /0 and quietly allow the whole
 * address space.
 */
function parseEntry(entry: string): ParsedEntry | null {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    const family = isIP(entry);
    return family ? { addr: entry, prefix: null, family: family as 4 | 6 } : null;
  }
  const addr = entry.slice(0, slash);
  const rawPrefix = entry.slice(slash + 1);
  const family = isIP(addr);
  if (!family || !/^\d+$/.test(rawPrefix)) return null;
  const prefix = Number(rawPrefix);
  if (prefix > (family === 6 ? 128 : 32)) return null;
  return { addr, prefix, family: family as 4 | 6 };
}

/** "1.2.3.4", "10.0.0.0/8", "2001:db8::/32" — parseable by ipInCidrs? */
export function isValidCidr(entry: string): boolean {
  return parseEntry(entry.trim()) !== null;
}

/**
 * Is `ip` inside any of the CIDR entries? Unparseable entries are skipped —
 * they are rejected at write time, and one bad row must not take the matcher
 * down (which, for an allowlist, would lock everyone out).
 *
 * Matching is family-strict: an entry only ever matches an address of its own
 * family. Node's BlockList counts IPv4-mapped addresses as inside an IPv6
 * subnet, so "::/0" would otherwise also admit every IPv4 client — for an
 * ALLOWLIST that error runs in the dangerous direction.
 */
export function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const normalized = normalizeIp(ip);
  const family = isIP(normalized);
  if (!family) return false;
  const type = family === 6 ? "ipv6" : "ipv4";
  const list = new BlockList();
  let matchable = false;
  for (const raw of cidrs) {
    const parsed = parseEntry(raw.trim());
    if (!parsed || parsed.family !== family) continue;
    matchable = true;
    if (parsed.prefix === null) list.addAddress(parsed.addr, type);
    else list.addSubnet(parsed.addr, parsed.prefix, type);
  }
  return matchable && list.check(normalized, type);
}
