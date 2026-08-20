/**
 * The tool-set resolution truth table (#27). These cases are the contract:
 * which rule wins, what a role with no sets does, and that "" is a category
 * rather than a wildcard.
 */

import { describe, expect, it } from "vitest";
import {
  describeReason,
  resolveCeiling,
  ruleMatches,
  ruleSpecificity,
  type ToolFacts,
  type ToolSetRule,
} from "./toolsets.js";

const facts: ToolFacts = {
  upstreamId: "cipp",
  toolName: "delete_user",
  tier: "destructive",
  group: "Identity",
};

let nextId = 0;
const rule = (partial: Partial<ToolSetRule>): ToolSetRule => ({
  id: ++nextId,
  setId: 1,
  scope: "shared",
  upstreamId: "cipp",
  groupLabel: null,
  tier: null,
  toolName: null,
  maxTier: "read",
  ...partial,
});

const ceiling = (rules: ToolSetRule[], opts: { hasAnySet?: boolean; legacyGrant?: "none" | "read" | "write" | "destructive" | null } = {}) =>
  resolveCeiling({
    facts,
    rules,
    hasAnySet: opts.hasAnySet ?? rules.length > 0,
    legacyGrant: opts.legacyGrant ?? null,
    roleDefault: "read",
  });

describe("selector matching", () => {
  it("treats an absent field as any and '' as the ungrouped bucket", () => {
    expect(ruleMatches(rule({}), facts)).toBe(true);
    expect(ruleMatches(rule({ groupLabel: "Identity" }), facts)).toBe(true);
    // "" is a real category — the tool is in "Identity", so it must NOT match
    expect(ruleMatches(rule({ groupLabel: "" }), facts)).toBe(false);
    expect(ruleMatches(rule({ groupLabel: "" }), { ...facts, group: "" })).toBe(true);
    expect(ruleMatches(rule({ tier: "read" }), facts)).toBe(false);
    expect(ruleMatches(rule({ toolName: "other" }), facts)).toBe(false);
    expect(ruleMatches(rule({ upstreamId: "cwpsa" }), facts)).toBe(false);
  });

  it("gives every selector shape a distinct weight, so shapes cannot tie", () => {
    const shapes = [
      rule({}),
      rule({ tier: "destructive" }),
      rule({ groupLabel: "Identity" }),
      rule({ groupLabel: "Identity", tier: "destructive" }),
      rule({ toolName: "delete_user" }),
      rule({ toolName: "delete_user", tier: "destructive" }),
      rule({ toolName: "delete_user", groupLabel: "Identity" }),
      rule({ toolName: "delete_user", groupLabel: "Identity", tier: "destructive" }),
    ].map(ruleSpecificity);
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe("which rule wins", () => {
  it("a group rule beats a server-wide one", () => {
    const c = ceiling([
      rule({ maxTier: "destructive" }),
      rule({ groupLabel: "Identity", maxTier: "read" }),
    ]);
    expect(c.maxTier).toBe("read");
  });

  it("a tier-scoped rule beats a plain group rule", () => {
    const c = ceiling([
      rule({ groupLabel: "Identity", maxTier: "read" }),
      rule({ groupLabel: "Identity", tier: "destructive", maxTier: "destructive" }),
    ]);
    expect(c.maxTier).toBe("destructive");
  });

  it("a tool rule beats everything else, including an exclusion", () => {
    const c = ceiling([
      rule({ groupLabel: "Identity", maxTier: "destructive" }),
      rule({ toolName: "delete_user", maxTier: "none" }),
    ]);
    expect(c.maxTier).toBe("none");
  });

  it("same selector in two shared sets: the more permissive wins (sets are additive)", () => {
    const c = ceiling([
      rule({ setId: 1, groupLabel: "Identity", maxTier: "read" }),
      rule({ setId: 2, groupLabel: "Identity", maxTier: "write" }),
    ]);
    expect(c.maxTier).toBe("write");
  });

  it("a role-private set wins a tie against a shared one", () => {
    const c = ceiling([
      rule({ setId: 1, scope: "shared", groupLabel: "Identity", maxTier: "destructive" }),
      rule({ setId: 2, scope: "role", groupLabel: "Identity", maxTier: "read" }),
    ]);
    expect(c.maxTier).toBe("read");
  });

  it("specificity dominates scope — a narrow shared rule beats a broad private one", () => {
    const c = ceiling([
      rule({ setId: 2, scope: "role", maxTier: "destructive" }),
      rule({ setId: 1, scope: "shared", groupLabel: "Identity", tier: "destructive", maxTier: "none" }),
    ]);
    expect(c.maxTier).toBe("none");
  });

  it("is order-independent", () => {
    const rules = [
      rule({ maxTier: "destructive" }),
      rule({ groupLabel: "Identity", maxTier: "read" }),
      rule({ toolName: "delete_user", maxTier: "write" }),
    ];
    const forward = ceiling(rules).maxTier;
    const backward = ceiling([...rules].reverse()).maxTier;
    expect(forward).toBe(backward);
    expect(forward).toBe("write");
  });
});

describe("closed world vs legacy", () => {
  it("a role with sets excludes what no rule mentions, ignoring the legacy grant", () => {
    const c = ceiling([rule({ upstreamId: "cwpsa", maxTier: "write" })], {
      hasAnySet: true,
      legacyGrant: "destructive",
    });
    expect(c.maxTier).toBe("none");
    expect(c.reason.kind).toBe("closed-world");
  });

  it("a role with NO sets behaves exactly as before: grant, else role default", () => {
    const granted = ceiling([], { hasAnySet: false, legacyGrant: "destructive" });
    expect(granted.maxTier).toBe("destructive");
    expect(granted.reason).toEqual({ kind: "legacy", source: "grant" });

    const fallback = ceiling([], { hasAnySet: false, legacyGrant: null });
    expect(fallback.maxTier).toBe("read");
    expect(fallback.reason).toEqual({ kind: "legacy", source: "role-default" });
  });

  it("rules inherit: a new tool in a covered category needs no re-save", () => {
    const rules = [rule({ groupLabel: "Identity", maxTier: "write" })];
    const brandNew: ToolFacts = { ...facts, toolName: "invite_guest", tier: "write" };
    expect(resolveCeiling({ facts: brandNew, rules, hasAnySet: true, legacyGrant: null, roleDefault: "none" }).maxTier).toBe("write");
  });
});

describe("explaining the decision", () => {
  it("names the winning rule, the closed world, and the legacy path", () => {
    const winner = rule({ groupLabel: "Identity", maxTier: "read", setId: 7 });
    expect(describeReason({ kind: "rule", rule: winner }, () => "helpdesk")).toBe(
      'rule cipp · Identity → read in set "helpdesk"'
    );
    expect(describeReason({ kind: "rule", rule: rule({ groupLabel: "", maxTier: "none" }) })).toContain("(ungrouped)");
    expect(describeReason({ kind: "closed-world" })).toContain("no assigned set");
    expect(describeReason({ kind: "legacy", source: "grant" })).toContain("grant");
  });
});
