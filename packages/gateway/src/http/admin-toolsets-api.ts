/**
 * Admin API for named tool sets (#27) and the self-service ceiling (#35).
 *
 * Mounted INSIDE the admin router, so it inherits the isAdmin gate. Every
 * answer about "what does this rule cover" or "what would this change" is
 * computed by running the real resolver over the live catalog — never by a
 * second implementation that could drift from the boundary.
 *
 *   GET/POST/DELETE  /api/tool-sets[/:id]
 *   GET/PUT/DELETE   /api/tool-sets/:id/rules[/:ruleId]   rules carry live match counts
 *   PUT              /api/tool-sets/:id/roles             {roleId, assigned, mode, dryRun?}
 *   POST             /api/roles/:id/convert-grants        {setName?, dryRun?}
 *   GET              /api/roles/:id/explain               ?upstreamId=&toolName=
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { CatalogEntry } from "../domain/catalog.js";
import { describeReason, ruleMatches, type SetMode, type ToolFacts } from "../domain/toolsets.js";
import { effectiveGroupOf, effectiveTierOf } from "../domain/tool-targets.js";
import type { AppDeps } from "./app.js";

const maxTierSchema = z.enum(["none", "read", "write", "destructive"]);
const tierSchema = z.enum(["read", "write", "destructive"]);
const modeSchema = z.enum(["granted", "self-service"]);

/** Selector fields: absent = "any", "" = the ungrouped bucket (a real category). */
const ruleBody = z.object({
  upstreamId: z.string().min(1),
  groupLabel: z.string().nullable().optional(),
  tier: tierSchema.nullable().optional(),
  toolName: z.string().nullable().optional(),
  maxTier: maxTierSchema,
});

const idOf = (req: Request, name: string): number => {
  const raw = req.params[name];
  return Number(Array.isArray(raw) ? raw[0] : raw);
};

export function createToolSetsRouter(
  deps: AppDeps,
  hooks: { onPolicyChanged: () => void }
): Router {
  const { repo, manager, policy } = deps;
  const router = Router();

  const h =
    (fn: (req: Request, res: Response) => void) =>
    (req: Request, res: Response): void => {
      try {
        fn(req, res);
      } catch (err) {
        const status = err instanceof z.ZodError ? 400 : 500;
        if (!res.headersSent) res.status(status).json({ error: String((err as Error)?.message ?? err) });
      }
    };

  const factsOf = (entry: CatalogEntry): ToolFacts => ({
    upstreamId: entry.upstreamId,
    toolName: entry.upstreamToolName,
    tier: effectiveTierOf(repo, entry),
    group: effectiveGroupOf(repo, entry),
  });

  /** Tools a rule currently covers — a 0 here is the warning an admin needs. */
  const matchesOf = (rule: Parameters<typeof ruleMatches>[0]): CatalogEntry[] =>
    [...manager.catalogEntries()].filter((entry) => ruleMatches(rule, factsOf(entry)));

  const visibleNames = (roleId: number): Set<string> =>
    new Set(policy.visibleEntries(roleId, manager.catalogEntries()).map((e) => e.exposedName));

  // ── sets ──

  router.get(
    "/tool-sets",
    h((_req, res) => {
      const roles = repo.listRoles();
      res.json(
        repo.listToolSets().map((set) => ({
          ...set,
          ruleCount: repo.rulesOfSet(set.id).length,
          assignedTo: roles
            .flatMap((role) =>
              repo
                .setsOfRole(role.id)
                .filter((s) => s.id === set.id)
                .map((s) => ({ roleId: role.id, roleName: role.name, mode: s.mode }))
            ),
        }))
      );
    })
  );

  router.post(
    "/tool-sets",
    h((req, res) => {
      const body = z
        .object({
          name: z.string().min(1).regex(/^[a-z0-9_-]+$/, "lowercase letters, digits, dash and underscore only"),
          description: z.string().optional(),
          scope: z.enum(["shared", "role"]).default("shared"),
          ownerRoleId: z.number().int().nullable().optional(),
        })
        .parse(req.body);
      if (repo.toolSetByName(body.name)) {
        res.status(409).json({ error: `Tool set "${body.name}" already exists` });
        return;
      }
      if (body.scope === "role" && (body.ownerRoleId == null || !repo.roleById(body.ownerRoleId))) {
        res.status(400).json({ error: "A role-scoped set needs an existing ownerRoleId" });
        return;
      }
      const set = repo.createToolSet({
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        scope: body.scope,
        ...(body.ownerRoleId != null ? { ownerRoleId: body.ownerRoleId } : {}),
      });
      // A role-private set is only ever meant for its owner, so assign it now
      // rather than leaving a set nobody can see the effect of.
      if (set.scope === "role" && set.ownerRoleId != null) {
        repo.assignToolSet(set.ownerRoleId, set.id, "granted");
        hooks.onPolicyChanged();
      }
      res.json(set);
    })
  );

  router.delete(
    "/tool-sets/:id",
    h((req, res) => {
      if (!repo.deleteToolSet(idOf(req, "id"))) {
        res.status(404).json({ error: "Unknown tool set" });
        return;
      }
      // Cascades to its rules and assignments — roles that relied on it may
      // fall back to legacy or lose their closed world entirely.
      hooks.onPolicyChanged();
      res.json({ ok: true });
    })
  );

  // ── rules ──

  router.get(
    "/tool-sets/:id/rules",
    h((req, res) => {
      const setId = idOf(req, "id");
      if (!repo.listToolSets().some((s) => s.id === setId)) {
        res.status(404).json({ error: "Unknown tool set" });
        return;
      }
      res.json(
        repo.rulesOfSet(setId).map((rule) => {
          const matches = matchesOf(rule);
          return {
            ...rule,
            matchCount: matches.length,
            sampleMatches: matches.slice(0, 5).map((e) => e.exposedName),
          };
        })
      );
    })
  );

  router.put(
    "/tool-sets/:id/rules",
    h((req, res) => {
      const setId = idOf(req, "id");
      if (!repo.listToolSets().some((s) => s.id === setId)) {
        res.status(404).json({ error: "Unknown tool set" });
        return;
      }
      const body = ruleBody.parse(req.body);
      if (!repo.getUpstream(body.upstreamId)) {
        res.status(404).json({ error: `Unknown upstream "${body.upstreamId}"` });
        return;
      }
      repo.setToolSetRule({ setId, ...body });
      hooks.onPolicyChanged();
      // Report what it covers RIGHT NOW: a rule matching nothing is usually a
      // typo in a category name, and silence is how that goes unnoticed.
      const saved = repo.rulesOfSet(setId).find(
        (r) =>
          r.upstreamId === body.upstreamId &&
          r.groupLabel === (body.groupLabel ?? null) &&
          r.tier === (body.tier ?? null) &&
          r.toolName === (body.toolName ?? null)
      )!;
      const matches = matchesOf(saved);
      res.json({
        ok: true,
        rule: saved,
        matchCount: matches.length,
        sampleMatches: matches.slice(0, 5).map((e) => e.exposedName),
      });
    })
  );

  router.delete(
    "/tool-sets/:id/rules/:ruleId",
    h((req, res) => {
      if (!repo.deleteToolSetRule(idOf(req, "ruleId"))) {
        res.status(404).json({ error: "Unknown rule" });
        return;
      }
      hooks.onPolicyChanged();
      res.json({ ok: true });
    })
  );

  // ── assignment (the blast-radius preview lives here) ──

  router.put(
    "/tool-sets/:id/roles",
    h((req, res) => {
      const setId = idOf(req, "id");
      const set = repo.listToolSets().find((s) => s.id === setId);
      if (!set) {
        res.status(404).json({ error: "Unknown tool set" });
        return;
      }
      const body = z
        .object({
          roleId: z.number().int(),
          assigned: z.boolean(),
          mode: modeSchema.default("granted"),
          dryRun: z.boolean().default(false),
        })
        .parse(req.body);
      const role = repo.roleById(body.roleId);
      if (!role) {
        res.status(404).json({ error: "Unknown role" });
        return;
      }

      const before = visibleNames(role.id);
      const apply = (): Set<string> => {
        if (body.assigned) repo.assignToolSet(role.id, setId, body.mode);
        else repo.unassignToolSet(role.id, setId);
        return visibleNames(role.id);
      };
      // Preview by doing it for real and rolling back — same resolver, same
      // catalog, so the number shown is the number that will happen.
      const after = body.dryRun ? repo.dryRun(apply) : apply();

      const gained = [...after].filter((n) => !before.has(n));
      const lost = [...before].filter((n) => !after.has(n));
      if (!body.dryRun) hooks.onPolicyChanged();
      res.json({
        ok: true,
        dryRun: body.dryRun,
        mode: body.mode,
        before: before.size,
        after: after.size,
        gained: gained.length,
        lost: lost.length,
        sampleLost: lost.slice(0, 8),
        sampleGained: gained.slice(0, 8),
      });
    })
  );

  // ── migration helper: today's grants → an explicit set ──

  router.post(
    "/roles/:id/convert-grants",
    h((req, res) => {
      const role = repo.roleById(idOf(req, "id"));
      if (!role) {
        res.status(404).json({ error: "Unknown role" });
        return;
      }
      const body = z
        .object({ setName: z.string().min(1).regex(/^[a-z0-9_-]+$/).optional(), dryRun: z.boolean().default(false) })
        .parse(req.body ?? {});
      const name = body.setName ?? `${role.name}-converted`;

      // One rule per upstream in the LIVE catalog: grant ?? role default. The
      // single intentional change is that a NEWLY added upstream will be closed
      // for this role afterwards instead of inheriting the default.
      const upstreams = [...new Set([...manager.catalogEntries()].map((e) => e.upstreamId))].sort();
      const rules = upstreams.map((upstreamId) => ({
        upstreamId,
        maxTier: repo.grantFor(role.id, upstreamId) ?? role.defaultMaxTier,
      }));
      if (body.dryRun) {
        res.json({ ok: true, dryRun: true, setName: name, rules, wouldAssign: rules.length > 0 });
        return;
      }
      if (repo.toolSetByName(name)) {
        res.status(409).json({ error: `Tool set "${name}" already exists — pass a different setName` });
        return;
      }
      const set = repo.createToolSet({ name, description: `Converted from ${role.name}'s grants` });
      for (const rule of rules) repo.setToolSetRule({ setId: set.id, ...rule });
      repo.assignToolSet(role.id, set.id, "granted");
      hooks.onPolicyChanged();
      res.json({ ok: true, setId: set.id, setName: name, rules });
    })
  );

  // ── why? ──

  router.get(
    "/roles/:id/explain",
    h((req, res) => {
      const role = repo.roleById(idOf(req, "id"));
      if (!role) {
        res.status(404).json({ error: "Unknown role" });
        return;
      }
      const upstreamId = String(req.query.upstreamId ?? "");
      const toolName = String(req.query.toolName ?? "");
      const entry = [...manager.catalogEntries()].find(
        (e) => e.upstreamId === upstreamId && e.upstreamToolName === toolName
      );
      if (!entry) {
        res.status(404).json({ error: "That tool is not in the live catalog" });
        return;
      }
      const setNames = new Map(repo.listToolSets().map((s) => [s.id, s.name]));
      const describe = (mode: SetMode) => {
        const decision = policy.explain(role.id, entry, mode);
        return {
          ...decision,
          why: describeReason(decision.reason, (setId) => setNames.get(setId) ?? `set ${setId}`),
        };
      };
      res.json({
        role: role.name,
        tool: entry.exposedName,
        hasSets: repo.roleHasSets(role.id),
        granted: describe("granted"),
        selfService: describe("self-service"),
      });
    })
  );

  return router;
}
