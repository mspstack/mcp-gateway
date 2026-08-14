/**
 * Tool sets through the real Repo + PolicyService: the closed-world flip, the
 * migration guarantee (a role with no sets is untouched), and the self-service
 * ceiling (#35) — offered by an admin, live only once the user opts in.
 */

import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../db/index.js";
import { Repo } from "../db/repo.js";
import type { Principal } from "../auth/principal.js";
import { prefsIdentity, withRoles } from "../auth/principal.js";
import type { CatalogEntry } from "./catalog.js";
import { PolicyService } from "./policy.js";

const entry = (
  toolName: string,
  tier: "read" | "write" | "destructive",
  upstreamId: string,
  description = ""
): CatalogEntry => ({
  upstreamId,
  namespace: upstreamId,
  upstreamToolName: toolName,
  exposedName: `${upstreamId}_${toolName}`,
  tier,
  tool: { name: toolName, inputSchema: { type: "object" }, ...(description ? { description } : {}) } as Tool,
});

const tickets = entry("update_ticket", "write", "cwpsa", "[tickets] update it");
const invoice = entry("get_invoice", "read", "cwpsa", "[finance] read it");
const doc = entry("get_doc", "read", "itglue");

function setup() {
  const repo = new Repo(openDatabase(":memory:"));
  const policy = new PolicyService(repo);
  const role = repo.createRole("techs", "write");
  const principal: Principal = withRoles({ kind: "oidc", subject: "https://idp|u1", label: "alice" }, [
    { id: role.id, name: "techs", isAdmin: false },
  ]);
  return { repo, policy, role, principal, who: prefsIdentity(principal) };
}

describe("assigning the first set flips the role to a closed world", () => {
  it("before: the role default applies everywhere (unchanged behaviour)", () => {
    const { policy, role } = setup();
    expect(policy.allows(role.id, tickets)).toBe(true);
    expect(policy.allows(role.id, invoice)).toBe(true);
    expect(policy.allows(role.id, doc)).toBe(true);
  });

  it("after: only what the rules cover, and the legacy grant stops mattering", () => {
    const { repo, policy, role } = setup();
    repo.setGrant(role.id, "itglue", "destructive"); // legacy grant, about to be ignored
    const set = repo.createToolSet({ name: "helpdesk" });
    repo.setToolSetRule({ setId: set.id, upstreamId: "cwpsa", groupLabel: "tickets", maxTier: "write" });
    repo.assignToolSet(role.id, set.id, "granted");

    expect(policy.allows(role.id, tickets)).toBe(true);
    expect(policy.allows(role.id, invoice)).toBe(false); // different category
    expect(policy.allows(role.id, doc)).toBe(false); // grant ignored under closed world

    const why = policy.explain(role.id, doc);
    expect(why.reason.kind).toBe("closed-world");
    expect(why.maxTier).toBe("none");
  });

  it("an exclusion rule is explicit, and a tool rule beats the category", () => {
    const { repo, policy, role } = setup();
    const set = repo.createToolSet({ name: "helpdesk" });
    repo.setToolSetRule({ setId: set.id, upstreamId: "cwpsa", maxTier: "write" });
    repo.setToolSetRule({ setId: set.id, upstreamId: "cwpsa", groupLabel: "finance", maxTier: "none" });
    repo.assignToolSet(role.id, set.id, "granted");

    expect(policy.allows(role.id, tickets)).toBe(true);
    expect(policy.allows(role.id, invoice)).toBe(false);

    // …and a per-tool rule can carve one tool back out of the exclusion
    repo.setToolSetRule({ setId: set.id, upstreamId: "cwpsa", toolName: "get_invoice", maxTier: "read" });
    expect(policy.allows(role.id, invoice)).toBe(true);
  });

  it("re-saving the same selector updates it instead of stacking rules", () => {
    const { repo, role } = setup();
    const set = repo.createToolSet({ name: "helpdesk" });
    repo.setToolSetRule({ setId: set.id, upstreamId: "cwpsa", groupLabel: "finance", maxTier: "read" });
    repo.setToolSetRule({ setId: set.id, upstreamId: "cwpsa", groupLabel: "finance", maxTier: "none" });
    const rules = repo.rulesOfSet(set.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.maxTier).toBe("none");
  });
});

describe("self-service ceiling", () => {
  function withSelfService() {
    const ctx = setup();
    const granted = ctx.repo.createToolSet({ name: "helpdesk" });
    ctx.repo.setToolSetRule({ setId: granted.id, upstreamId: "cwpsa", groupLabel: "tickets", maxTier: "write" });
    ctx.repo.assignToolSet(ctx.role.id, granted.id, "granted");

    const offered = ctx.repo.createToolSet({ name: "docs-and-plans" });
    ctx.repo.setToolSetRule({ setId: offered.id, upstreamId: "itglue", maxTier: "read" });
    ctx.repo.assignToolSet(ctx.role.id, offered.id, "self-service");
    return ctx;
  }

  it("is offered but not live until the user switches it on", () => {
    const { repo, policy, role, principal, who } = withSelfService();

    // not in the granted envelope…
    expect(policy.allows(role.id, doc)).toBe(false);
    // …but offered, and inert until an opt-in row exists
    expect(policy.selfServiceable(role.id, doc)).toBe(true);
    expect(policy.allowsFor(principal, doc)).toBe(false);

    repo.bulkSetUserPrefs(who, "itglue", ["get_doc"], true, true);
    expect(policy.allowsFor(principal, doc)).toBe(true);

    // the granted zone is unaffected by any of this
    expect(policy.allowsFor(principal, tickets)).toBe(true);
  });

  it("cannot widen past the ceiling the admin wrote in that set", () => {
    const { repo, policy, principal, who } = withSelfService();
    const write = entry("update_doc", "write", "itglue");
    repo.bulkSetUserPrefs(who, "itglue", ["update_doc", ""], true, true);
    // the self-service rule caps itglue at read — opting in cannot exceed it
    expect(policy.allowsFor(principal, write)).toBe(false);
    expect(policy.allowsFor(principal, doc)).toBe(true);
  });

  it("a personal deny still wins over an opt-in", () => {
    const { repo, policy, principal, who } = withSelfService();
    repo.bulkSetUserPrefs(who, "itglue", [""], true, true);
    expect(policy.allowsFor(principal, doc)).toBe(true);
    repo.setUserPref(who, "itglue", "get_doc", false);
    expect(policy.allowsFor(principal, doc)).toBe(false);
  });

  it("un-assigning the set takes the tool away, opt-in row or not", () => {
    const { repo, policy, role, principal, who } = withSelfService();
    repo.bulkSetUserPrefs(who, "itglue", ["get_doc"], true, true);
    expect(policy.allowsFor(principal, doc)).toBe(true);

    const offered = repo.toolSetByName("docs-and-plans")!;
    repo.unassignToolSet(role.id, offered.id);
    expect(policy.allowsFor(principal, doc)).toBe(false);
  });

  it("self-service alone does not make a role closed-world", () => {
    const { repo, policy, role } = setup();
    const offered = repo.createToolSet({ name: "extras" });
    repo.setToolSetRule({ setId: offered.id, upstreamId: "itglue", maxTier: "read" });
    repo.assignToolSet(role.id, offered.id, "self-service");

    // no GRANTED set → the legacy path still applies to everything else
    expect(policy.allows(role.id, tickets)).toBe(true);
    expect(policy.explain(role.id, tickets).reason.kind).toBe("legacy");
  });
});
