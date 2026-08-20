/**
 * Admin JSON API (mounted at /api, admin role required on every request).
 *
 * Drives the admin UI: upstream CRUD + preflight testing, catalog toggles,
 * roles/grants/overrides, users, group mappings, secret writes (values go
 * straight to the secret store, never into SQLite or responses), and MCP
 * registry search for the install flow.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ConfigError, parseUpstreamSpec } from "../config.js";
import { isMaxTier } from "../domain/policy.js";
import { derivedGroupOf } from "../domain/catalog.js";
import { resolveToolTargets } from "../domain/tool-targets.js";
import { listSnapshots, runBackup } from "../db/backup.js";
import { renderPreset, summarize } from "../domain/presets.js";
import { UpstreamConnection } from "../upstream/connection.js";
import { SERVER_VERSION } from "../mcp/gateway-server.js";
import { prefsIdentity, type Principal } from "../auth/principal.js";
import { createToolSetsRouter } from "./admin-toolsets-api.js";
import type { AppDeps, AuthOutcome } from "./app.js";

const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
/** Generous: servers with hundreds of tools (CIPP: 231) are slow to enumerate. */
const PREFLIGHT_TIMEOUT_MS = 45_000;

interface AdminDeps {
  resolveAuth: (req: Request) => Promise<AuthOutcome>;
  onPolicyChanged: () => void;
  /** Close matching live MCP sessions; returns how many were dropped. */
  reloadSessions: (match: (session: { principal: Principal }, sessionId: string) => boolean) => number;
  /** Live sessions for the support view (no secrets, identity + stream state). */
  sessionSummaries: () => Array<Record<string, unknown>>;
}

const tierSchema = z.enum(["read", "write", "destructive"]);

/** Express 5 types params as string | string[]; routes here are always scalar. */
const param = (req: Request, name: string): string => {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
};

export function createAdminRouter(deps: AppDeps, admin: AdminDeps): Router {
  const { repo, manager, policy, secretStore } = deps;
  const router = Router();

  // Every /api request requires an admin principal.
  router.use((req: Request, res: Response, next) => {
    admin
      .resolveAuth(req)
      .then((auth) => {
        if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
        if (!auth.principal.isAdmin) {
          return res.status(403).json({ error: "Admin role required" });
        }
        next();
      })
      .catch((err) => res.status(500).json({ error: String(err) }));
  });

  /** Async handler wrapper: thrown errors become JSON, config errors → 400. */
  const h =
    (fn: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response): void => {
      Promise.resolve(fn(req, res)).catch((err) => {
        const status = err instanceof ConfigError || err instanceof z.ZodError ? 400 : 500;
        if (!res.headersSent) res.status(status).json({ error: String(err?.message ?? err) });
      });
    };

  // ── status ──

  router.get(
    "/status",
    h(async (_req, res) => {
      const secretHealth = secretStore ? await secretStore.health() : null;
      res.json({
        version: SERVER_VERSION,
        upstreams: manager.summaries(),
        toolCount: [...manager.catalogEntries()].length,
        secretStore: secretHealth,
        oidc: deps.config.oidc ? { issuer: deps.config.oidc.issuer } : null,
        staticTokens: deps.config.staticTokens.map((t) => ({ label: t.label, role: t.roleName })),
      });
    })
  );

  // ── live MCP sessions (support: "their client is stuck on an old list") ──

  router.get(
    "/sessions",
    h((_req, res) => {
      res.json(admin.sessionSummaries());
    })
  );

  /**
   * Drop sessions so their clients must re-initialize and re-read tools/list.
   * Target one session or every session of one principal — never everything by
   * accident, and an in-flight call on a dropped session fails, so this is a
   * deliberate support action.
   */
  router.post(
    "/sessions/reload",
    h((req, res) => {
      const parsed = z
        .object({ sessionId: z.string().min(1).optional(), principal: z.string().min(1).optional() })
        .refine((b) => Boolean(b.sessionId) !== Boolean(b.principal), {
          message: "Pass exactly one of sessionId or principal",
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Pass exactly one of sessionId or principal" });
        return;
      }
      const body = parsed.data;
      const closed = body.sessionId
        ? admin.reloadSessions((_session, id) => id === body.sessionId)
        : admin.reloadSessions((session) => prefsIdentity(session.principal) === body.principal);
      res.json({ ok: true, closed });
    })
  );

  // ── upstreams ──

  router.get(
    "/upstreams",
    h((_req, res) => {
      res.json(repo.listUpstreams().map(({ spec, source }) => ({ ...spec, source })));
    })
  );

  // ── presets (one-click install of known MCP servers) ──

  const presets = deps.presets ?? [];

  router.get(
    "/presets",
    h((_req, res) => {
      res.json(presets.map(summarize));
    })
  );

  router.post(
    "/presets/:id/install",
    h(async (req, res) => {
      const preset = presets.find((p) => p.id === param(req, "id"));
      if (!preset) {
        res.status(404).json({ error: "Unknown preset" });
        return;
      }
      const body = z
        .object({
          params: z.record(z.string(), z.string()).default({}),
          dryRun: z.boolean().default(false),
        })
        .parse(req.body);
      const spec = renderPreset(preset, body.params); // ConfigError → 400 via h()
      if (body.dryRun) {
        res.json({ ok: true, spec });
        return;
      }
      repo.upsertUpstream(spec, "api");
      await manager.upsertUpstream(spec);

      // Recommended grants ship by role NAME — resolve per deployment;
      // unknown names are warnings, never failures.
      const grants: Array<{ role: string; maxTier: string }> = [];
      const warnings: string[] = [];
      for (const [roleName, maxTier] of Object.entries(preset.grants)) {
        const role = repo.roleByName(roleName);
        if (!role) {
          warnings.push(`role "${roleName}" does not exist — grant "${maxTier}" skipped`);
          continue;
        }
        repo.setGrant(role.id, spec.id, maxTier);
        grants.push({ role: roleName, maxTier });
      }
      admin.onPolicyChanged();
      console.error(`[presets] installed "${preset.id}" as upstream "${spec.id}" (${grants.length} grants)`);
      res.json({ ok: true, id: spec.id, grants, warnings });
    })
  );

  const saveUpstream = h(async (req, res) => {
    const spec = parseUpstreamSpec(req.body);
    const idParam = req.params.id === undefined ? undefined : param(req, "id");
    if (idParam !== undefined && idParam !== spec.id) {
      res.status(400).json({ error: "id in path and body must match" });
      return;
    }
    repo.upsertUpstream(spec, "api");
    await manager.upsertUpstream(spec);
    admin.onPolicyChanged();
    res.json({ ok: true, id: spec.id });
  });
  router.post("/upstreams", saveUpstream);
  router.put("/upstreams/:id", saveUpstream);

  router.delete(
    "/upstreams/:id",
    h(async (req, res) => {
      const id = param(req, "id");
      const existed = repo.deleteUpstream(id);
      await manager.removeUpstream(id);
      admin.onPolicyChanged();
      res.json({ ok: existed });
    })
  );

  router.post(
    "/upstreams/:id/enabled",
    h(async (req, res) => {
      const id = param(req, "id");
      const enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
      if (!repo.setUpstreamEnabled(id, enabled)) {
        res.status(404).json({ error: `Unknown upstream "${id}"` });
        return;
      }
      const row = repo.getUpstream(id)!;
      await manager.upsertUpstream(row.spec);
      admin.onPolicyChanged();
      res.json({ ok: true, enabled });
    })
  );

  /** Test a spec without saving it: connect, list tools, disconnect. */
  router.post(
    "/preflight",
    h(async (req, res) => {
      const spec = parseUpstreamSpec({ ...req.body, id: req.body.id ?? "preflight", namespace: req.body.namespace ?? "preflight" });
      const connection = new UpstreamConnection(spec, secretStore);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`preflight timed out after ${PREFLIGHT_TIMEOUT_MS / 1000}s`)), PREFLIGHT_TIMEOUT_MS).unref()
      );
      try {
        await Promise.race([connection.connect(), timeout]);
        const tools = await Promise.race([connection.listTools(), timeout]);
        res.json({ ok: true, toolCount: tools.length, tools: tools.slice(0, 50).map((t) => t.name) });
      } catch (err) {
        res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
      } finally {
        await connection.close().catch(() => undefined);
      }
    })
  );

  router.get(
    "/registry/search",
    h(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const response = await fetch(
        `${REGISTRY_URL}?${new URLSearchParams({ search: q, limit: "20" })}`
      );
      if (!response.ok) {
        res.status(502).json({ error: `registry returned HTTP ${response.status}` });
        return;
      }
      res.json(await response.json());
    })
  );

  // ── catalog (tools) ──

  router.get(
    "/catalog",
    h((_req, res) => {
      const settings = new Map(
        repo.listToolSettings().map((s) => [`${s.upstreamId}\u0000${s.toolName}`, s])
      );
      res.json(
        [...manager.catalogEntries()].map((entry) => {
          const setting = settings.get(`${entry.upstreamId}\u0000${entry.upstreamToolName}`);
          return {
            upstreamId: entry.upstreamId,
            toolName: entry.upstreamToolName,
            exposedName: entry.exposedName,
            description: entry.tool.description ?? "",
            derivedTier: entry.tier,
            tierOverride: setting?.tierOverride ?? null,
            effectiveTier: setting?.tierOverride ?? entry.tier,
            /** Category from the description (CIPP-style "[Identity > …]"). */
            derivedGroup: derivedGroupOf(entry.tool),
            enabled: setting?.enabled ?? true,
            groupLabel: setting?.groupLabel ?? null,
          };
        })
      );
    })
  );

  /**
   * Re-read every upstream's tool list. Discovery already re-runs on a
   * `tools/list_changed` notification and after a reconnect, but servers that
   * change their surface silently (a toolset header, a new endpoint set) need a
   * nudge — this is that nudge.
   */
  router.post(
    "/catalog/refresh",
    h(async (_req, res) => {
      await manager.refreshCatalog();
      const perUpstream: Record<string, number> = {};
      for (const entry of manager.catalogEntries()) {
        perUpstream[entry.upstreamId] = (perUpstream[entry.upstreamId] ?? 0) + 1;
      }
      admin.onPolicyChanged();
      res.json({ ok: true, toolCount: [...manager.catalogEntries()].length, perUpstream });
    })
  );

  router.patch(
    "/catalog/:upstreamId",
    h((req, res) => {
      const upstreamId = param(req, "upstreamId");
      const body = z
        .object({
          enabled: z.boolean(),
          tier: tierSchema.optional(),
          group: z.string().optional(),
        })
        .parse(req.body);
      // Resolve the affected tools from the LIVE catalog: a stale UI can never
      // create settings rows for tools that don't exist.
      const entries = [...manager.catalogEntries()].filter((e) => e.upstreamId === upstreamId);
      if (entries.length === 0) {
        res.status(404).json({ error: `Unknown upstream "${upstreamId}" (or it has no tools)` });
        return;
      }
      // Effective tier (override wins) and effective group (explicit label,
      // else the derived category) — one shared implementation, so this and the
      // /me switches can't drift apart.
      const targets = resolveToolTargets(repo, entries, {
        upstreamId,
        ...(body.tier ? { tier: body.tier } : {}),
        ...(body.group !== undefined ? { group: body.group } : {}),
      });
      const changed = repo.bulkSetToolEnabled(
        upstreamId,
        targets.map((e) => e.upstreamToolName),
        body.enabled
      );
      admin.onPolicyChanged();
      res.json({ ok: true, changed });
    })
  );

  router.patch(
    "/catalog/:upstreamId/:toolName",
    h((req, res) => {
      const body = z
        .object({
          enabled: z.boolean().optional(),
          tierOverride: tierSchema.nullable().optional(),
          groupLabel: z.string().nullable().optional(),
        })
        .parse(req.body);
      repo.upsertToolSetting({
        upstreamId: param(req, "upstreamId"),
        toolName: param(req, "toolName"),
        ...body,
      });
      admin.onPolicyChanged();
      res.json({ ok: true });
    })
  );

  // ── roles / grants / overrides ──

  router.get(
    "/roles",
    h((_req, res) => {
      res.json({
        roles: repo.listRoles(),
        grants: repo.listGrants(),
        overrides: repo.listOverrides(),
      });
    })
  );

  router.post(
    "/roles",
    h((req, res) => {
      const body = z
        .object({
          name: z.string().min(1).regex(/^[a-z0-9_-]+$/),
          defaultMaxTier: z.enum(["none", "read", "write", "destructive"]),
          isAdmin: z.boolean().default(false),
        })
        .parse(req.body);
      if (repo.roleByName(body.name)) {
        res.status(409).json({ error: `Role "${body.name}" already exists` });
        return;
      }
      res.json(repo.createRole(body.name, body.defaultMaxTier, body.isAdmin));
    })
  );

  router.delete(
    "/roles/:id",
    h((req, res) => {
      const ok = repo.deleteRole(Number(req.params.id));
      if (!ok) {
        res.status(400).json({ error: "Role not found or protected" });
        return;
      }
      admin.onPolicyChanged();
      res.json({ ok: true });
    })
  );

  router.put(
    "/grants",
    h((req, res) => {
      const body = z
        .object({
          roleId: z.number().int(),
          upstreamId: z.string().min(1),
          maxTier: z.union([z.enum(["none", "read", "write", "destructive"]), z.null()]),
        })
        .parse(req.body);
      if (!isMaxTier(body.maxTier) && body.maxTier !== null) {
        res.status(400).json({ error: "invalid maxTier" });
        return;
      }
      if (body.maxTier === null) repo.clearGrant(body.roleId, body.upstreamId);
      else repo.setGrant(body.roleId, body.upstreamId, body.maxTier);
      admin.onPolicyChanged();
      res.json({ ok: true });
    })
  );

  router.put(
    "/overrides",
    h((req, res) => {
      const body = z
        .object({
          roleId: z.number().int(),
          upstreamId: z.string().min(1),
          toolName: z.string().min(1),
          effect: z.union([z.enum(["allow", "deny"]), z.null()]),
        })
        .parse(req.body);
      if (body.effect === null) repo.clearOverride(body.roleId, body.upstreamId, body.toolName);
      else repo.setOverride(body.roleId, body.upstreamId, body.toolName, body.effect);
      admin.onPolicyChanged();
      res.json({ ok: true });
    })
  );

  // ── Entra directory search (admin-only; group/user pickers) ──
  // App-only Graph via the login app's own credentials — never an inbound
  // token. configured:false when unavailable so the UI degrades to paste-an-id.

  router.get(
    "/directory/search",
    h(async (req, res) => {
      const search = deps.directorySearch ?? null;
      if (!search) {
        res.json({ configured: false, results: [] });
        return;
      }
      const q = String(req.query.q ?? "").trim();
      const typeRaw = String(req.query.type ?? "all");
      const type = typeRaw === "user" || typeRaw === "group" ? typeRaw : "all";
      if (q.length < 2) {
        res.json({ configured: true, results: [] });
        return;
      }
      try {
        res.json({ configured: true, results: await search.search(q, type) });
      } catch (err) {
        console.error(`[directory] search failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(502).json({ error: "directory search failed" });
      }
    })
  );

  // ── OAuth clients (DCR facade) ──
  // Registered dynamically by MCP clients; deletion cascades the client's
  // authorization codes and refresh tokens. Outstanding ACCESS tokens are
  // stateless JWTs and keep working until they expire (≤1h).

  router.get(
    "/oauth-clients",
    h((_req, res) => {
      res.json(repo.listOauthClients());
    })
  );

  router.delete(
    "/oauth-clients/:clientId",
    h((req, res) => {
      const clientId = param(req, "clientId");
      if (!repo.deleteOauthClient(clientId)) {
        res.status(404).json({ error: "Unknown client" });
        return;
      }
      console.error(`[oauth] admin deleted client ${clientId} (codes + refresh tokens revoked)`);
      res.json({ ok: true });
    })
  );

  // ── users / group mappings ──

  router.get(
    "/users",
    h((_req, res) => {
      // roleId is the ADMIN override; loginRoles are what the user's groups
      // mapped to at their last login. Effective access is the union of
      // whichever applies (#28), so show both rather than one "role" column.
      res.json(
        repo.listUsers().map((user) => {
          const loginRoles = repo.loginRoles(user.id).map((r) => r.name);
          const override = user.roleId != null ? repo.roleById(user.roleId)?.name ?? null : null;
          return {
            ...user,
            loginRoles,
            effectiveRoles: override ? [override] : loginRoles,
          };
        })
      );
    })
  );

  router.put(
    "/users/:id/role",
    h((req, res) => {
      const body = z.object({ roleId: z.number().int().nullable() }).parse(req.body);
      if (body.roleId !== null && !repo.roleById(body.roleId)) {
        res.status(400).json({ error: "Unknown role" });
        return;
      }
      if (!repo.setUserRole(Number(req.params.id), body.roleId)) {
        res.status(404).json({ error: "Unknown user" });
        return;
      }
      admin.onPolicyChanged();
      res.json({ ok: true });
    })
  );

  /**
   * Forget a user: the row, their group-derived roles, personal prefs,
   * credential refs, refresh tokens, and any live session. NOT a revocation —
   * anyone still in a mapped group returns on their next login — so the
   * response says what actually happened rather than implying more.
   */
  router.delete(
    "/users/:id",
    h((req, res) => {
      const removed = repo.deleteUser(Number(param(req, "id")));
      if (!removed) {
        res.status(404).json({ error: "Unknown user" });
        return;
      }
      const sessionsClosed = admin.reloadSessions(
        (session) => prefsIdentity(session.principal) === removed.principal
      );
      admin.onPolicyChanged();
      console.error(`[admin] deleted user ${removed.principal} (${sessionsClosed} session(s) closed)`);
      res.json({
        ok: true,
        ...removed,
        sessionsClosed,
        note:
          removed.credentials > 0
            ? "Credential refs removed; the values still exist in the secret store and need deleting there."
            : undefined,
      });
    })
  );

  router.get(
    "/group-mappings",
    h(async (_req, res) => {
      // Enrich stored claim GUIDs with directory display names (cosmetic —
      // failures or no Graph just mean the UI shows raw ids).
      const mappings = repo.listGroupMappings();
      const names = deps.directorySearch
        ? await deps.directorySearch.namesByIds(mappings.map((m) => m.claimValue))
        : {};
      res.json(mappings.map((m) => ({ ...m, claimLabel: names[m.claimValue] ?? null })));
    })
  );

  router.put(
    "/group-mappings",
    h((req, res) => {
      const body = z
        .object({ iss: z.string().min(1), claimValue: z.string().min(1), roleId: z.number().int() })
        .parse(req.body);
      if (!repo.roleById(body.roleId)) {
        res.status(400).json({ error: "Unknown role" });
        return;
      }
      repo.setGroupMapping(body.iss, body.claimValue, body.roleId);
      res.json({ ok: true });
    })
  );

  router.delete(
    "/group-mappings/:id",
    h((req, res) => {
      res.json({ ok: repo.deleteGroupMapping(Number(req.params.id)) });
    })
  );

  // ── secrets ──

  router.put(
    "/secrets",
    h(async (req, res) => {
      if (!secretStore) {
        res.status(503).json({ error: "No secret store configured — set BAO_ADDR or KEY_VAULT_URI" });
        return;
      }
      const body = z
        .object({
          path: z.string().min(1).regex(/^[A-Za-z0-9/_-]+$/),
          field: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/),
          value: z.string().min(1),
        })
        .parse(req.body);
      // Key Vault secret names are stricter than the shared shape above
      // (no "/" or "_") — pre-check so the client gets a 400, not a 500.
      if (secretStore.scheme === "kv" && !/^[0-9A-Za-z-]+$/.test(`${body.path}-${body.field}`)) {
        res.status(400).json({
          error: `Key Vault secret names allow only letters, digits, and dashes — "${body.path}-${body.field}" is invalid`,
        });
        return;
      }
      await secretStore.put(body.path, body.field, body.value);
      // Never echo the value; return only the ref to paste into an upstream spec.
      res.json({ ok: true, ref: secretStore.refFor(body.path, body.field) });
    })
  );

  // ── backups ──

  router.get(
    "/backups",
    h((_req, res) => {
      const { dir, keep, intervalHours, blobContainerUrl } = deps.config.backup;
      res.json({
        dir,
        keep,
        intervalHours,
        offInstance: blobContainerUrl ? "configured" : null,
        snapshots: listSnapshots(dir).map(({ name, sizeBytes, createdAt }) => ({
          name,
          sizeBytes,
          createdAt,
        })),
      });
    })
  );

  router.post(
    "/backups",
    h(async (_req, res) => {
      if (!deps.db) {
        res.status(503).json({ error: "No database handle available for backups" });
        return;
      }
      const file = await runBackup(deps.db, deps.config.backup, deps.backupUploader);
      res.json({ ok: true, name: file.name, sizeBytes: file.sizeBytes, createdAt: file.createdAt });
    })
  );

  router.get(
    "/secrets/health",
    h(async (_req, res) => {
      // `scheme` drives the UI's ref hints (kv:name-field vs bao:path#field).
      res.json(
        secretStore
          ? { ...(await secretStore.health()), scheme: secretStore.scheme }
          : { ok: false, detail: "not configured", scheme: null }
      );
    })
  );

  // Tool sets (#27) + the self-service ceiling (#35). Mounted here so it
  // inherits the isAdmin gate above rather than re-implementing it.
  router.use(createToolSetsRouter(deps, { onPolicyChanged: admin.onPolicyChanged }));

  return router;
}
