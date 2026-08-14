/**
 * Additive roles (issue #28): a principal holding several roles gets their
 * UNION. Being added to a group can only ever widen access — the surprise this
 * prevents is "we gave you billing access" silently removing ticket access.
 */

import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { openDatabase } from "../db/index.js";
import { Repo } from "../db/repo.js";
import type { Principal } from "../auth/principal.js";
import { principalKey, withRoles } from "../auth/principal.js";
import type { CatalogEntry } from "./catalog.js";
import { PolicyService } from "./policy.js";

const tool = (name: string): Tool => ({ name, inputSchema: { type: "object" } });
const entry = (
  upstreamToolName: string,
  tier: "read" | "write" | "destructive",
  upstreamId: string
): CatalogEntry => ({
  upstreamId,
  namespace: upstreamId,
  upstreamToolName,
  exposedName: `${upstreamId}_${upstreamToolName}`,
  tier,
  tool: tool(upstreamToolName),
});

/**
 * Two deliberately INCOMPARABLE roles, the case "highest tier wins" got wrong:
 * techs may write tickets and cannot touch billing; billing may write invoices
 * and cannot touch tickets. Neither contains the other.
 */
function setup() {
  const repo = new Repo(openDatabase(":memory:"));
  const policy = new PolicyService(repo);
  const techs = repo.createRole("techs", "none");
  const billing = repo.createRole("billing", "none");
  repo.setGrant(techs.id, "tickets", "write");
  repo.setGrant(billing.id, "invoices", "write");

  const asRoles = (...roles: Array<{ id: number; name: string }>): Principal =>
    withRoles(
      { kind: "oidc", subject: "https://idp|u1", label: "alice" },
      roles.map((r) => ({ id: r.id, name: r.name, isAdmin: false }))
    );

  return { repo, policy, techs, billing, asRoles };
}

const ticket = entry("update_ticket", "write", "tickets");
const invoice = entry("update_invoice", "write", "invoices");

describe("role union", () => {
  it("keeps both surfaces where a single winner would drop one", () => {
    const { policy, techs, billing, asRoles } = setup();

    const techOnly = asRoles(techs);
    expect(policy.allowsFor(techOnly, ticket)).toBe(true);
    expect(policy.allowsFor(techOnly, invoice)).toBe(false);

    // Adding the billing group must ADD invoices without removing tickets.
    const both = asRoles(techs, billing);
    expect(policy.allowsFor(both, ticket)).toBe(true);
    expect(policy.allowsFor(both, invoice)).toBe(true);
    expect(policy.envelopeFor(both, [ticket, invoice]).map((e) => e.upstreamId)).toEqual([
      "tickets",
      "invoices",
    ]);
  });

  it("takes the most permissive ceiling per upstream, not the first role's", () => {
    const { repo, policy, techs, billing, asRoles } = setup();
    // techs are capped at read on invoices, billing may write them
    repo.setGrant(techs.id, "invoices", "read");
    const both = asRoles(techs, billing);
    expect(policy.allowsFor(both, entry("get_invoice", "read", "invoices"))).toBe(true);
    expect(policy.allowsFor(both, invoice)).toBe(true);

    // …and a role granted "none" doesn't drag the union down
    repo.setGrant(techs.id, "invoices", "none");
    expect(policy.allowsFor(both, invoice)).toBe(true);
  });

  it("a per-role deny closes that role's path only — the kill switch closes all", () => {
    const { repo, policy, techs, billing, asRoles } = setup();
    repo.setGrant(billing.id, "tickets", "write");
    repo.setOverride(techs.id, "tickets", "update_ticket", "deny");
    const both = asRoles(techs, billing);

    // still reachable through billing: subtracting for everyone is not a role's job
    expect(policy.allows(techs.id, ticket)).toBe(false);
    expect(policy.allowsFor(both, ticket)).toBe(true);

    // the global kill switch is the absolute one
    repo.upsertToolSetting({ upstreamId: "tickets", toolName: "update_ticket", enabled: false });
    expect(policy.allowsFor(both, ticket)).toBe(false);
  });

  it("an admin role anywhere in the list makes the principal an admin", () => {
    const { repo, techs } = setup();
    const adminRole = repo.roleByName("admin")!;
    const principal = withRoles({ kind: "oidc", subject: "https://idp|u1", label: "alice" }, [
      { id: techs.id, name: "techs", isAdmin: false },
      { id: adminRole.id, name: "admin", isAdmin: true },
    ]);
    expect(principal.isAdmin).toBe(true);
    // primary stays the first entry (callers order most-privileged-first)
    expect(principal.roleId).toBe(techs.id);
    expect(principal.roleName).toBe("techs+admin");
  });

  it("the session binding key covers the whole role set, order-independently", () => {
    const { techs, billing, asRoles } = setup();
    expect(principalKey(asRoles(techs, billing))).toBe(principalKey(asRoles(billing, techs)));
    // losing a role changes the key → the existing 403 forces a reconnect
    expect(principalKey(asRoles(techs))).not.toBe(principalKey(asRoles(techs, billing)));
  });
});
