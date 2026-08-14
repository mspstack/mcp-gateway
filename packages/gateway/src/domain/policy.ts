/**
 * Policy engine: which tools a role can see and call.
 *
 * Two-layer enforcement (mcp-itglue's model, generalized): tools/list
 * filtering is UX, the call-time check is the security boundary — both go
 * through the same PolicyService so they can never disagree.
 *
 * Effective visibility of a tool for a role:
 *   toolEnabled ∧ (override(allow) ∨ (tier ≤ maxTier ∧ ¬override(deny)))
 * where tier = admin tierOverride ?? annotation-derived tier, and
 * maxTier = per-upstream grant ?? the role's default.
 */

import type { CatalogEntry, Tier } from "./catalog.js";
import { derivedGroupOf } from "./catalog.js";
import { resolveCeiling, type CeilingReason, type SetMode } from "./toolsets.js";
import type { Repo, RoleRow } from "../db/repo.js";
import type { Principal } from "../auth/principal.js";
import { prefsIdentity } from "../auth/principal.js";

export type { Tier };
export type MaxTier = Tier | "none";

const TIER_RANK: Record<MaxTier, number> = { none: 0, read: 1, write: 2, destructive: 3 };

export const isMaxTier = (value: unknown): value is MaxTier =>
  value === "none" || value === "read" || value === "write" || value === "destructive";

export function tierAllowed(maxTier: MaxTier, tier: Tier): boolean {
  return TIER_RANK[maxTier] >= TIER_RANK[tier];
}

/** Pure decision function — heavily unit-tested. */
export function toolAllowed(input: {
  toolEnabled: boolean;
  effectiveTier: Tier;
  maxTier: MaxTier;
  override: "allow" | "deny" | null;
}): boolean {
  if (!input.toolEnabled) return false;
  if (input.override === "deny") return false;
  if (input.override === "allow") return true;
  return tierAllowed(input.maxTier, input.effectiveTier);
}

/** Everything behind one allow/deny — see PolicyService.explain. */
export interface Decision {
  allowed: boolean;
  maxTier: MaxTier;
  effectiveTier: Tier;
  toolEnabled: boolean;
  override: "allow" | "deny" | null;
  reason: CeilingReason;
}

export class PolicyService {
  constructor(private readonly repo: Repo) {}

  roleFor(roleId: number): RoleRow | null {
    return this.repo.roleById(roleId);
  }

  /** The single authorization decision, used by list filtering AND call-time checks. */
  allows(roleId: number, entry: CatalogEntry): boolean {
    return this.explain(roleId, entry).allowed;
  }

  /**
   * The decision plus every input that produced it — the same code path
   * `allows` uses, so an explanation can never describe a different outcome
   * than the boundary enforces. Powers the admin "why?" view and the /me hints.
   */
  explain(roleId: number, entry: CatalogEntry, mode: SetMode = "granted"): Decision {
    const role = this.repo.roleById(roleId);
    if (!role) {
      return { allowed: false, maxTier: "none", effectiveTier: entry.tier, toolEnabled: true, override: null, reason: { kind: "closed-world" } };
    }
    const setting = this.repo.toolSetting(entry.upstreamId, entry.upstreamToolName);
    const effectiveTier = setting?.tierOverride ?? entry.tier;
    const override = this.repo.overrideFor(roleId, entry.upstreamId, entry.upstreamToolName);

    // Sets decide the ceiling when the role has any; otherwise the legacy
    // grant/default path runs untouched, which is what keeps a set-less
    // deployment byte-for-byte identical (#27).
    const { maxTier, reason } = resolveCeiling({
      facts: {
        upstreamId: entry.upstreamId,
        toolName: entry.upstreamToolName,
        tier: effectiveTier,
        group: setting?.groupLabel ?? derivedGroupOf(entry.tool) ?? "",
      },
      rules: this.repo.rulesForRole(roleId, mode),
      // Self-service is additive on top of the granted world, so it is never
      // "closed" on its own: with no self-service rules it simply offers nothing.
      hasAnySet: mode === "granted" ? this.repo.roleHasSets(roleId) : true,
      legacyGrant: this.repo.grantFor(roleId, entry.upstreamId),
      roleDefault: role.defaultMaxTier,
    });

    return {
      allowed: toolAllowed({
        toolEnabled: setting?.enabled ?? true,
        effectiveTier,
        maxTier,
        override,
      }),
      maxTier,
      effectiveTier,
      toolEnabled: setting?.enabled ?? true,
      override,
      reason,
    };
  }

  /**
   * Would this tool be self-serviceable by the role — i.e. offered by a set
   * assigned in `self-service` mode? Not live until the user opts in (#35).
   */
  selfServiceable(roleId: number, entry: CatalogEntry): boolean {
    return this.explain(roleId, entry, "self-service").allowed;
  }

  visibleEntries(roleId: number, entries: Iterable<CatalogEntry>): CatalogEntry[] {
    return [...entries].filter((entry) => this.allows(roleId, entry));
  }

  /**
   * The envelope of a principal holding several roles: the UNION (issue #28).
   * Each role is evaluated on its own — its grant, its default tier, its own
   * per-tool overrides — so a `deny` override closes that role's path and not
   * the others'. Subtracting for everyone is what the kill switch is for.
   */
  allowsAny(roleIds: readonly number[], entry: CatalogEntry): boolean {
    return roleIds.some((roleId) => this.allows(roleId, entry));
  }

  /** Envelope of every role the principal holds (no personal prefs applied). */
  envelopeFor(principal: Principal, entries: Iterable<CatalogEntry>): CatalogEntry[] {
    const roleIds = principal.roles.map((r) => r.id);
    return [...entries].filter((entry) => this.allowsAny(roleIds, entry));
  }

  /**
   * Personal narrowing (slice 3): effective = admin envelope ∧ user prefs.
   * Prefs are deny-only rows (an upstream-wide '' row or a per-tool row), so
   * this can only ever REMOVE access relative to allows() — never widen it.
   * Same function gates tools/list and tools/call, like the envelope itself.
   */
  allowsFor(principal: Principal, entry: CatalogEntry): boolean {
    const roleIds = principal.roles.map((r) => r.id);
    const who = prefsIdentity(principal);
    const serverPref = this.repo.userPrefFor(who, entry.upstreamId, "");
    const toolPref = this.repo.userPrefFor(who, entry.upstreamId, entry.upstreamToolName);
    const optedIn = serverPref === true || toolPref === true;
    const denied = serverPref === false || toolPref === false;

    if (this.allowsAny(roleIds, entry)) {
      // Off-by-default upstreams invert the personal layer: nothing is live
      // until the user opts in (server-wide or per tool). The envelope check
      // above is still the ceiling, so an opt-in can never widen beyond it.
      if (this.repo.getUpstream(entry.upstreamId)?.spec.userDefault === "off") {
        return denied ? false : optedIn;
      }
      return !denied;
    }

    // Self-service zone (#35): outside the granted envelope but offered by a
    // set assigned in self-service mode. Never live by itself — an explicit
    // opt-in row is what turns it on, and it is still capped by that set's own
    // ceiling, so this cannot widen past what an admin wrote.
    if (!optedIn || denied) return false;
    return roleIds.some((roleId) => this.selfServiceable(roleId, entry));
  }

  visibleEntriesFor(principal: Principal, entries: Iterable<CatalogEntry>): CatalogEntry[] {
    return [...entries].filter((entry) => this.allowsFor(principal, entry));
  }

  /**
   * WHY a call was refused — only so the caller can be told about a switch they
   * own. `"personal"`/`"optIn"` mean the admin envelope allows the tool and the
   * caller's own layer is what closes it; such a tool is already listed on their
   * /me page, so naming it reveals nothing they can't see there. Everything
   * else stays `"envelope"` and keeps the no-oracle wording.
   */
  denialReason(principal: Principal, entry: CatalogEntry): "allowed" | "envelope" | "personal" | "optIn" {
    if (!this.allowsAny(principal.roles.map((r) => r.id), entry)) return "envelope";
    if (this.allowsFor(principal, entry)) return "allowed";
    return this.repo.getUpstream(entry.upstreamId)?.spec.userDefault === "off" ? "optIn" : "personal";
  }
}
