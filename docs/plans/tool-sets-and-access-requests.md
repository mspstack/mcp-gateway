# Named tool sets for roles + access requests

> **Status: PLANNED — not started.** Self-contained: a fresh session in this
> repo can execute it without prior conversation context. Design settled
> 2026-07-30; three decisions still open (see [Open questions](#open-questions)).

## 1. Why

Roles grant access today by *tier ceiling per upstream* (`grants`) plus a
per-tool `allow`/`deny` escape hatch (`tool_overrides`) that has **no UI at all**
and is unreachable from the `gw_*` toolset. That vocabulary doesn't fit the
deployment it has to serve: 6 roles, 313 tools, CIPP alone contributing 231
across 9 categories and cwpsa 39 across 7 toolsets. What an admin actually wants
to say is *"techs-ro gets cwpsa/tickets and cipp/Identity, nothing else"* — the
unit is a **category**, not a server, and the assignment wants a **name** so it
can be reused across roles.

Second half of the same problem: a user who needs one more tool has no path
except pinging an admin out of band. `/me` shows only what the role already
grants, so users can't even see what exists.

Decisions taken (owner, 2026-07-30):

1. **Named tool sets as a first-class entity** — reusable, cross-server, nameable.
2. **A set defines the availability filter for a role**; anything beyond a role's
   sets is obtained through **request → admin approval**.
3. **The full catalog is visible on `/me`, tool names included**, with a Request
   affordance. The `/mcp` protocol surface keeps its no-existence-oracle
   behaviour unchanged — `/me` is an authenticated human UI, `/mcp` is the
   boundary.

## 2. The rule, in one sentence

> A role's tool sets decide what it can reach; the most specific matching rule
> sets the ceiling; a per-role tool deny closes anything; the global kill switch
> closes it for everyone; the user's own `/me` switches can only narrow further.

Corollary that makes migration safe: **a role with no sets assigned behaves
exactly as today** (legacy grant ?? role default). Assigning the first set flips
that role to closed-world.

## 3. Schema — migration v5 (`src/db/index.ts`)

Four tables in one migration block, following the existing
`if (version < N) { … }` idiom. No data changes, no seeds.

- `tool_sets(id, name UNIQUE slug, description, scope 'shared'|'role',
  owner_role_id → roles CASCADE, source 'api'|'preset', created_at)`.
  `scope:'role'` is a role's private exception set — auto-assigned to its owner
  and wins ties against shared sets. `CHECK ((scope='role') = (owner_role_id IS NOT NULL))`.
- `tool_set_rules(id, set_id → tool_sets CASCADE, upstream_id, group_label,
  tier, tool_name, max_tier)`. Selector semantics: **`NULL` = any, `''` = the
  ungrouped bucket** (first-class, not a wildcard). `max_tier` is a ceiling in
  the existing vocabulary — `'none'` means excluded. Unique index over
  `(set_id, upstream_id, COALESCE(group_label,…), COALESCE(tier,…), COALESCE(tool_name,…))`
  so rules upsert by selector (SQLite treats NULLs as distinct in a plain UNIQUE).
- `role_tool_sets(role_id, set_id, assigned_at)` PK(role_id, set_id).
- `access_requests(id, principal, requester_label, role_id, upstream_id,
  group_label, tool_name, requested_tier, reason, status, created_at, decided_at,
  decided_by, decision_note, applied_json)` with
  `status IN ('pending','approved','denied','withdrawn','stale')` and a **partial
  unique index on `(principal, target) WHERE status='pending'`** so a re-click
  merges instead of duplicating. Ships in v5 even though it stays inert until
  phase 3 — one migration, less churn.

`grants` and `tool_overrides` are untouched and keep working.

**Rules carry a ceiling, not include/exclude**: `max_tier` subsumes include
(`destructive` = everything), gives `none` as first-class exclusion, and reuses
the vocabulary already in every select in the UI.

## 4. Resolution — new pure module `src/domain/toolsets.ts`

```ts
interface SetRule {
  ruleId: number; setId: number; scope: "shared" | "role";
  upstreamId: string;
  group: string | null;    // null = any, "" = ungrouped
  tier: Tier | null;       // null = any
  toolName: string | null; // null = any
  maxTier: MaxTier;
}
interface ToolFacts { upstreamId; toolName; effectiveGroup: string; effectiveTier: Tier }

ruleMatches(rule, facts): boolean
ruleSpecificity(rule): number            // 1 + 8·tool + 4·group + 2·tier
resolveMaxTier({facts, rules, hasAnySet, legacyGrant, roleDefault})
  → { maxTier, reason }
```

Ladder evaluated in `PolicyService`, first decision wins:

1. `tool_settings.enabled = 0` → **deny**. Absolute; not negotiable by anything.
2. `tool_overrides(role, upstream, tool)`: `deny` → deny, `allow` → allow.
3. `maxTier` from `resolveMaxTier`, then allow iff `effectiveTier ≤ maxTier`.
   Matching rules → best by **specificity desc → scope (role-private first) →
   most permissive → setId/ruleId asc** (a total order). No match ∧ `hasAnySet`
   → `none` (closed world). Else `legacyGrant ?? roleDefault`.
4. `allowsFor` only: AND the personal `user_prefs` layer (narrow-only, or opt-in
   for `userDefault:"off"` upstreams).

`toolAllowed()` keeps its exact signature and body — the new code only computes
the `maxTier` it already takes, so `tools/list` and `tools/call` stay one code
path. Add `PolicyService.explain(roleId, entry) → Decision` (allowed + every
input + `reason`); `allows()` becomes `explain().allowed`. `explain` powers a
"why?" popover, `GET /api/roles/:id/explain` and `gw_explain_access`.

**Load rules once per request, not per tool.** `policy.forPrincipal(principal)`
returns an evaluator with the principal's rules, per-user grants and prefs
pre-loaded (tens of rows), so a 313-tool `tools/list` costs no extra queries and
`explain` is free.

### Truth table (encode as tests)

Upstream `cipp`, tool `delete_user`, group `Identity`, effective tier
`destructive`, role default `read`.

| enabled | override | matching rules | legacy grant | has sets | ⇒ |
|---|---|---|---|---|---|
| 0 | any | any | any | any | **deny** — kill switch beats everything |
| 1 | deny | `{cipp}`=destructive | — | yes | **deny** — per-role deny beats rules |
| 1 | allow | `{cipp}`=none | — | yes | **allow** — exclusion is not absolute |
| 1 | — | none | destructive | **yes** | **deny** — closed world |
| 1 | — | none | destructive | **no** | **allow** — legacy, identical to today |
| 1 | — | `{cipp}`=destructive + `{cipp,Identity}`=read | — | yes | **deny** — group beats server |
| 1 | — | `{cipp,Identity}`=read + `{cipp,Identity,destructive}`=destructive | — | yes | **allow** — tier-scoped beats group |
| 1 | — | `{cipp,Identity}`=destructive + `{cipp,tool}`=none | — | yes | **deny** — tool rule wins |
| 1 | — | shared A=read + shared B=write (same selector) | — | yes | **write** — shared sets are additive |
| 1 | — | shared=destructive + role-private=read (same selector) | — | yes | **read** — private wins the tie |
| 1 | — | role-private=destructive + shared `{…,destructive}`=none | — | yes | **deny** — specificity dominates scope |
| 1 | — | `{cipp,group:""}`=destructive (tool is in `Identity`) | — | yes | **deny** — `''` ≠ wildcard |
| 1 | — | `{cipp,Identity}`=write, a NEW write tool appears in Identity | — | yes | **allow** — inherited, no re-save |

## 5. Additive roles (do this BEFORE sets ship)

`resolveOidcRole` picks **one** role today: an explicit `users.role_id` override,
else the highest group mapping (`ORDER BY is_admin DESC, tier_rank DESC LIMIT 1`).
That was harmless while roles were nested by tier. With closed-world sets it
becomes a silent loss: a person in *Techs* (set: cwpsa/tickets + cipp/Identity)
and *Billing* (`cs-rw`, write) gets only `cs-rw` and loses the whole Identity
surface.

Model: a principal carries **a list of roles**, and

> ceiling = **max** over each of the principal's roles (within a role: most
> specific rule wins) and their per-user grants; then narrowed by `/me` prefs.

Adding a group to a person can therefore only widen access, never narrow it —
the only semantics that doesn't surprise. Subtractive levers stay outside roles:
the global kill switch and (recommended) an **admin per-user deny** in the same
table as per-user grants, which beats everything except the kill switch.

Touches: `Principal` (`roleId` → role list), `principalKey` (sorted role ids —
a group change mid-session yields the existing 403 + reconnect),
`visibleFingerprint`, `PolicyService.allows`, `resolveOidcRole` →
`resolveOidcRoles` (an explicit user override still *replaces* group-derived
roles), `/me` and the Users tab showing all matched roles and which role grants
each group.

**Timing:** prod has exactly one group mapping today (`Core Services → editor`),
so the switch changes nobody's access to a single tool. With five mappings it
would need an audit first.

## 6. Access requests

- **Shapes**: whole server / one group (`''` = ungrouped) / one tool, plus a
  requested tier and optional reason. Both group and tool set → 400.
- **Validation at POST**: upstream exists and is enabled; target resolves to ≥1
  live tool (globally disabled → **422 unavailable**, never requestable); already
  permitted → **409** with the `explain` reason attached.
- **Duplicates merge**: the same target re-requested raises the tier if higher
  and refreshes the reason → `{deduped: true}`, no user-facing conflict.
- **Approval is per-user by default.** `POST /api/requests/:id/approve` takes a
  scope: `user` (default — writes a **per-user grant**, optionally time-boxed),
  `set-rule` (into an assigned set, the role's private set, or a new set), or
  `grant`/`override-allow` for the legacy shapes. The response and UI state the
  blast radius ("this also grants N other members of `techs-ro`") **before** the
  click. What was written lands in `applied_json` for audit.
- **Time-boxed access**: per-user grants (and optionally rules) carry
  `expires_at`. Requests are usually "I need this for today's ticket" — the
  default suggestion is 8 hours, and JIT beats permanently handing out
  `ExecGetRecoveryKey`.
- `Repo.decideAccessRequest()` owns one transaction and starts with
  `UPDATE … WHERE status='pending'`; `changes === 0` → **409 already decided**.
- **An admin may not approve their own request** → 409 "ask another admin".
  Free four-eyes: an admin can edit the set directly if they mean to.
- `stale` when the target leaves the catalog: swept when the queue is listed and
  on `POST /api/catalog/refresh`; `deleteUpstream` also stales its requests and
  deletes its rules. Never hard-deleted.

## 7. API surface

New sub-routers mounted **inside** `createAdminRouter`, so the existing
`isAdmin` middleware gates them: `src/http/admin-toolsets-api.ts`,
`src/http/admin-requests-api.ts`.

```
GET/POST/PUT/DELETE  /api/tool-sets[/:id]
GET/PUT/DELETE       /api/tool-sets/:id/rules[/:ruleId]   → each rule carries a LIVE match count
PUT                  /api/tool-sets/:id/roles   {roleId, assigned, dryRun?, force?}
                                                → {diff:{gained,lost,sampleLost}}
POST                 /api/roles/:id/convert-grants  {setName?, dryRun?}
GET                  /api/roles/:id/explain?upstreamId=&toolName=
GET                  /api/requests?status=          (stale sweep first)
POST                 /api/requests/:id/approve|deny
GET/DELETE           /api/credentials[/:principal/:upstreamId/:field]   (hygiene, see issue #9)
```

User side (`/api/me`, any principal): `GET /api/me/catalog` (full tree annotated
`granted | granted-off | requested | requestable | unavailable`),
`POST /api/me/requests`, `GET /api/me/requests`, `DELETE /api/me/requests/:id`
(withdraw own pending). `GET /api/me/access` stays for compatibility.

`gw_*` additions: **`gw_set_override`** (the currently missing scalpel),
**`gw_explain_access`** (decision trace), `gw_list_tool_sets`, `gw_set_rule`,
`gw_assign_tool_set`, `gw_list_requests`, `gw_approve_request`,
`gw_deny_request` (same self-approval block).

## 8. UI (vanilla, no build step)

**Roles becomes the single access screen.** Role list on the left (rules count,
member count); on the right the selected role's rules table — server, category,
tier filter, ceiling, live match count, and whether the rule came from a set or
the role itself. Set chips at the top with "+ apply set" and "save rules as
set", so a set is a *saved template of rules*, not a second place to look.
Assigning a set dry-runs first and confirms "this removes N tools (e.g. …)";
a role with no rules offers **"start from current access"** (convert-grants)
inline, so nobody closes half a role by accident. Below: **Personal exceptions**
— who, what, ceiling, expiry countdown, who granted it and why, revoke.

**Requests** panel: requester, target, tier, reason, age; per request a scope
select ("this person only" / "whole role — N people") and a duration select
(8 hours / 7 days / no expiry), then Approve / Deny with a note.

**`/me`**: catalog-driven tree (server → category → tool) with four renderings —
toggle (granted), toggle (granted-off), greyed + **Request** (requestable),
`pending` pill + Withdraw (requested); group and server headers get
"Request group (read|write)"; a **My requests** panel below. Clicking a greyed
row shows *why* (from `explain`).

## 9. Migration / compat

v5 is inert: no sets → legacy branch → the deployment is byte-identical.
`POST /api/roles/:id/convert-grants` emits one
`{upstreamId, group:null, tier:null, tool:null, max_tier: grant ?? role default}`
rule per upstream currently in the catalog, leaving `tool_overrides` alone.

For the NDR deployment specifically: cipp's `none` grants for the five
non-admin roles become explicit `none` rules (still closed, now visible in the
UI instead of implied), and the six `destructive` tier overrides on the
secret-returning CIPP tools keep raising `effectiveTier` exactly as today. The
single intentional behaviour change, and it only tightens: after conversion a
**newly added upstream** is closed for a set-driven role instead of inheriting
the role default.

## 10. Traps

1. **Full-catalog visibility leaks the vendor stack** through upstream ids and
   tool names (`cipp` ⇒ M365 tenants under management; `cw_list_invoices` ⇒
   billing surface), and `/api/me/*` accepts static-token principals too, so one
   leaked low-tier `MCP_TOKENS_*` becomes an infrastructure oracle. Mitigations:
   descriptions envelope-only (CIPP's `[Identity > Administration > Users]`
   paths are the real detail leak); a per-upstream `discoverable:false` spec
   flag; `ME_CATALOG_VISIBILITY=full|envelope`; `/mcp` wording regression-tested
   unchanged; catalog browsing logged with the principal label.
2. **Exclusion is not absolute**: an `allow` override beats a `none` rule; only
   `tool_settings.enabled=0` is absolute. Say so in UI help text, not just a
   code comment. (Removing `tool_overrides` in favour of tool-scoped rules would
   remove this wart — considered, deferred to keep the migration inert.)
3. **Group names come from upstreams** (`_meta.group` / `_meta.toolset` /
   `[Category > …]` description prefix). An upstream renaming a category orphans
   rules silently — the per-rule live match count with a `0 matches` badge is
   the detector.
4. **Vendor-side toolsets are a third meaning of the word.** cwpsa's
   `x-cw-toolsets` header narrows what the upstream *publishes*; it must stay an
   admin-only knob (spec-level, broadest value) and never a personal credential
   field, or a user can narrow their own link below what policy grants and get
   "tool not found" from the upstream instead of a policy answer.

## Open questions

1. Catalog visibility for **static-token principals**: full (uniform with the
   decision) or envelope-only (recommended — automation isn't browsing)?
2. Add an **admin per-user deny** alongside per-user grants? Recommended: with
   additive roles there is otherwise no way to say "never LAPS for this person,
   whatever groups they're in".
3. Should `tool_overrides` be folded into tool-scoped rules (one mechanism, no
   "exclusion isn't absolute" wart) or kept as-is for an inert migration?

## Phasing

- **Phase 0** — fix the `/me` group bulk switches for servers with derived
  groups (`me-api.ts` filters `groupLabel` with no `derivedGroupOf` fallback →
  `changed: 0` for cipp/cwpsa), and dedupe the three inline near-copies onto
  `domain/tool-targets.ts`. Own commit, no schema.
- **Phase 1** — additive roles (§5), then migration v5 + Repo + `toolsets.ts` +
  `PolicyService.explain` + `forPrincipal`. Zero behaviour change for roles
  without sets; existing policy tests must pass untouched.
- **Phase 2** — admin surface for sets: endpoints, assignment dry-run diff,
  convert-grants, explain, the Roles screen, `gw_set_override` /
  `gw_explain_access` / set tools.
- **Phase 3** — requests end to end: per-user time-boxed grants,
  `/api/me/catalog`, `/me` catalog + Request + My requests, admin Requests
  panel, `gw_*` request tools, the §10.1 mitigations.
- **Phase 4** — preset-shipped sets, `docs/toolsets.md` for operators,
  CLAUDE.md / README / ui-guide updates, version bump + release.

## Verification

1. `npm run build && npm test` — new suites: `domain/toolsets.test.ts` (truth
   table, specificity distinctness, all tie-break levels),
   `domain/tool-targets.test.ts` (derived-group fallback, `''` vs `null`),
   extended `policy.test.ts` (**roles without sets identical to today**;
   additive roles), `repo.test.ts` (rule upsert idempotency, cascades, request
   dedupe, decide rollback), `me-api.test.ts` (**derived-group regression**,
   catalog states, request lifecycle), `admin-api.test.ts` (set CRUD, dry-run
   diff, approval scopes, non-admin 403, self-approval 409), `app.test.ts`
   (`/mcp` forbidden-tool wording unchanged).
2. Dev gateway against the real cwpsa/cipp upstreams: build a "helpdesk" set
   (`cwpsa/tickets=write`, `cipp/Identity=read`), assign it to a fresh role,
   confirm `tools/list` for that role contains exactly the expected tools, that
   `gw_explain_access` explains a denial correctly, and that the `/me` group
   switches report `changed > 0`.
3. Prod: `convert-grants` with `dryRun` on techs-ro / cs-rw / managers-ro and
   compare the diff against today's grants **before** applying anything.
