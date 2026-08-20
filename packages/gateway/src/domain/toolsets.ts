/**
 * Named tool sets (#27) and the self-service ceiling (#35) — the pure decision
 * layer. No database, no HTTP: given a tool's facts and the rules that apply to
 * a role, produce the ceiling and the reason for it.
 *
 * A rule is a SELECTOR plus a ceiling:
 *
 *   { upstreamId, groupLabel?, tier?, toolName?, maxTier }
 *
 * where an absent selector field means "any", and `groupLabel: ""` means the
 * ungrouped bucket — a real category, not a wildcard. `maxTier: "none"` is a
 * first-class exclusion.
 *
 * The most SPECIFIC matching rule wins, so a broad "all of cwpsa is read" and a
 * narrow "cwpsa/tickets is write" compose the way people expect. Ties are broken
 * by scope (a role's private set beats a shared one), then by permissiveness,
 * then by id — a total order, so the outcome never depends on row order.
 */

import type { MaxTier, Tier } from "./policy.js";

export type SetScope = "shared" | "role";
export type SetMode = "granted" | "self-service";

export interface ToolSetRule {
  id: number;
  setId: number;
  /** Which set it came from — only its scope matters to resolution. */
  scope: SetScope;
  upstreamId: string;
  /** null = any category; "" = the ungrouped bucket. */
  groupLabel: string | null;
  /** null = any tier; otherwise only tools whose EFFECTIVE tier matches. */
  tier: Tier | null;
  /** null = any tool. */
  toolName: string | null;
  maxTier: MaxTier;
}

/** What we know about the tool being judged. */
export interface ToolFacts {
  upstreamId: string;
  toolName: string;
  /** Effective tier: admin override ?? annotation-derived. */
  tier: Tier;
  /** Effective category: explicit label ?? derived ?? "" (ungrouped). */
  group: string;
}

export function ruleMatches(rule: ToolSetRule, facts: ToolFacts): boolean {
  if (rule.upstreamId !== facts.upstreamId) return false;
  if (rule.toolName !== null && rule.toolName !== facts.toolName) return false;
  if (rule.groupLabel !== null && rule.groupLabel !== facts.group) return false;
  if (rule.tier !== null && rule.tier !== facts.tier) return false;
  return true;
}

/**
 * Distinct per selector SHAPE, so no two shapes can tie: tool (8) beats group
 * (4) beats tier (2) beats the bare upstream (1). The +1 base keeps an
 * upstream-only rule above "no rule at all".
 */
export function ruleSpecificity(rule: ToolSetRule): number {
  return 1 + (rule.toolName !== null ? 8 : 0) + (rule.groupLabel !== null ? 4 : 0) + (rule.tier !== null ? 2 : 0);
}

const TIER_RANK: Record<MaxTier, number> = { none: 0, read: 1, write: 2, destructive: 3 };

/**
 * Total order over matching rules: specificity, then a role-private set over a
 * shared one, then the more permissive ceiling, then ids. Deterministic on
 * purpose — "which rule won" has to be explainable to an admin.
 */
function betterRule(a: ToolSetRule, b: ToolSetRule): ToolSetRule {
  const bySpecificity = ruleSpecificity(a) - ruleSpecificity(b);
  if (bySpecificity !== 0) return bySpecificity > 0 ? a : b;
  const byScope = (a.scope === "role" ? 1 : 0) - (b.scope === "role" ? 1 : 0);
  if (byScope !== 0) return byScope > 0 ? a : b;
  const byTier = TIER_RANK[a.maxTier] - TIER_RANK[b.maxTier];
  if (byTier !== 0) return byTier > 0 ? a : b;
  if (a.setId !== b.setId) return a.setId < b.setId ? a : b;
  return a.id <= b.id ? a : b;
}

export type CeilingReason =
  /** A rule from an assigned set decided it. */
  | { kind: "rule"; rule: ToolSetRule }
  /** The role has sets, and none of them mention this tool → closed world. */
  | { kind: "closed-world" }
  /** The role has no sets at all → legacy grant/default, byte-for-byte as before. */
  | { kind: "legacy"; source: "grant" | "role-default" };

export interface Ceiling {
  maxTier: MaxTier;
  reason: CeilingReason;
}

/**
 * The ceiling for ONE mode's rules (granted or self-service, never mixed).
 *
 * `hasAnySet` is what makes a role closed-world: with sets assigned, a tool no
 * rule mentions is excluded, and the legacy grant is ignored entirely. Without
 * sets, the legacy path runs untouched — that is the migration guarantee.
 */
export function resolveCeiling(input: {
  facts: ToolFacts;
  rules: readonly ToolSetRule[];
  hasAnySet: boolean;
  legacyGrant: MaxTier | null;
  roleDefault: MaxTier;
}): Ceiling {
  let winner: ToolSetRule | null = null;
  for (const rule of input.rules) {
    if (!ruleMatches(rule, input.facts)) continue;
    winner = winner === null ? rule : betterRule(winner, rule);
  }
  if (winner) return { maxTier: winner.maxTier, reason: { kind: "rule", rule: winner } };
  if (input.hasAnySet) return { maxTier: "none", reason: { kind: "closed-world" } };
  return input.legacyGrant !== null
    ? { maxTier: input.legacyGrant, reason: { kind: "legacy", source: "grant" } }
    : { maxTier: input.roleDefault, reason: { kind: "legacy", source: "role-default" } };
}

/** Human-readable trace for /me, the admin "why?" popover and gw_explain_access. */
export function describeReason(reason: CeilingReason, setName?: (setId: number) => string): string {
  switch (reason.kind) {
    case "rule": {
      const { rule } = reason;
      const parts = [rule.upstreamId];
      if (rule.toolName !== null) parts.push(`tool ${rule.toolName}`);
      if (rule.groupLabel !== null) parts.push(rule.groupLabel === "" ? "(ungrouped)" : rule.groupLabel);
      if (rule.tier !== null) parts.push(`${rule.tier} tier`);
      const where = setName ? ` in set "${setName(rule.setId)}"` : "";
      return `rule ${parts.join(" · ")} → ${rule.maxTier}${where}`;
    }
    case "closed-world":
      return "no assigned set covers this tool";
    case "legacy":
      return reason.source === "grant" ? "per-upstream grant (no sets assigned)" : "role default (no sets assigned)";
  }
}
