/**
 * User self-service API (integrated-mode slice 3), mounted at /api/me for ANY
 * authenticated principal — this is the backend the Toolbox "My MCP Access"
 * app talks to with the operator's own Entra token.
 *
 * - GET  /api/me/access                    effective servers+tools (envelope ∧ prefs)
 * - PUT  /api/me/prefs                     narrow-only toggles (enable = remove narrowing)
 * - GET  /api/me/credentials               registered credential REFS (never values)
 * - PUT  /api/me/credentials/:upstreamId   store a personal credential; ref only comes back
 * - DELETE /api/me/credentials/:upstreamId/:field
 *
 * Credentials registered here are consumed by per-principal upstream sessions
 * (sessionMode — slice 5); until then they are stored + rotatable but unused.
 * The value goes straight to the secret store under
 * gw-user-<principalSlug>-<upstreamId>[-<field>]; SQLite keeps only the ref.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prefsIdentity, principalSlug, type Principal } from "../auth/principal.js";
import { effectiveGroupOf, effectiveTierOf, resolveToolTargets } from "../domain/tool-targets.js";
import type { AppDeps, AuthOutcome } from "./app.js";

interface MeDeps {
  resolveAuth: (req: Request) => Promise<AuthOutcome>;
  onPolicyChanged: () => void;
}

export function createMeRouter(deps: AppDeps, me: MeDeps): Router {
  const { repo, manager, policy, secretStore } = deps;
  const router = Router();

  // One-click Connect needs the interactive-login cookie flow, the connect
  // service AND a secret store to land the refresh token in — advertise it
  // only when the /me/connect routes are actually mounted and functional.
  const connectAvailable = Boolean(
    deps.config.login && deps.loginService && deps.userConnect && secretStore
  );

  // Any authenticated principal — no admin requirement here.
  router.use((req: Request & { principal?: Principal }, res: Response, next) => {
    me.resolveAuth(req)
      .then((auth) => {
        if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
        req.principal = auth.principal;
        next();
      })
      .catch((err) => res.status(500).json({ error: String(err) }));
  });

  const h =
    (fn: (req: Request & { principal?: Principal }, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response): void => {
      Promise.resolve(fn(req, res)).catch((err) => {
        const status = err instanceof z.ZodError ? 400 : 500;
        if (!res.headersSent) res.status(status).json({ error: String(err?.message ?? err) });
      });
    };

  router.get(
    "/access",
    h((req, res) => {
      const principal = req.principal!;
      const who = prefsIdentity(principal);
      const prefs = repo.listUserPrefs(who);
      const serverPref = new Map(prefs.filter((p) => p.toolName === "").map((p) => [p.upstreamId, p.enabled]));

      // Only entries inside the admin envelope are listed at all — personal
      // narrowing is shown on top of them; envelope-denied tools stay invisible.
      // `enabled` comes from PolicyService.allowsFor — the SAME function the
      // MCP boundary uses — so the page can never disagree with reality
      // (including the inverted opt-in rule of userDefault:"off" upstreams).
      const byUpstream = new Map<
        string,
        Array<{ name: string; exposedName: string; tier: string; group: string; enabled: boolean }>
      >();
      for (const entry of policy.visibleEntries(principal.roleId, manager.catalogEntries())) {
        const list = byUpstream.get(entry.upstreamId) ?? [];
        list.push({
          name: entry.upstreamToolName,
          exposedName: entry.exposedName,
          // Tier and group come from the SAME helpers the bulk switches resolve
          // targets with, so what the page groups by is what a click acts on.
          tier: effectiveTierOf(repo, entry),
          group: effectiveGroupOf(repo, entry),
          enabled: policy.allowsFor(principal, entry),
        });
        byUpstream.set(entry.upstreamId, list);
      }
      res.json({
        principal: { label: principal.label, role: principal.roleName },
        servers: [...byUpstream.entries()].map(([upstreamId, tools]) => {
          const spec = repo.getUpstream(upstreamId)?.spec;
          const optIn = spec?.userDefault === "off";
          return {
            upstreamId,
            // Server switch state: opt-in servers are "on" once an explicit
            // server-wide opt-in exists; normal ones until a deny appears.
            enabled: optIn ? serverPref.get(upstreamId) === true : serverPref.get(upstreamId) !== false,
            // One-click Connect offer (metadata only — the flow itself lives
            // at /me/connect/:upstreamId and needs the cookie session).
            connect: connectAvailable && spec?.userConnect
              ? { label: spec.userConnect.label, tokenField: spec.userConnect.tokenField }
              : null,
            requiresPersonalCredentials: spec?.requirePersonalCredentials ?? false,
            /** "off" = opt-in server: nothing is live until the user enables it. */
            userDefault: spec?.userDefault ?? "on",
            // Declared personal-credential fields → /me renders a labeled
            // guided form instead of raw name/value inputs.
            credentialFields: spec?.personalCredentials ?? [],
            tools,
          };
        }),
      });
    })
  );

  router.put(
    "/prefs",
    h((req, res) => {
      const principal = req.principal!;
      const body = z
        .object({
          upstreamId: z.string().min(1),
          toolName: z.string().default(""),
          /** Bulk forms: a whole tier and/or group of the upstream at once. */
          tier: z.enum(["read", "write", "destructive"]).optional(),
          group: z.string().optional(),
          enabled: z.boolean(),
        })
        .parse(req.body);

      // Prefs only make sense inside the envelope; reject junk targets so the
      // table can't fill with garbage (and enabling can never widen anyway —
      // "enable" just deletes the personal deny row).
      const envelope = policy.visibleEntries(principal.roleId, manager.catalogEntries());
      const upstreamKnown = envelope.some((e) => e.upstreamId === body.upstreamId);
      const toolKnown =
        body.toolName === "" ||
        envelope.some((e) => e.upstreamId === body.upstreamId && e.upstreamToolName === body.toolName);
      if (!upstreamKnown || !toolKnown) {
        res.status(404).json({ error: "Unknown upstream or tool (or outside your access)" });
        return;
      }

      // Bulk: resolve the tools from the caller's OWN envelope, so one click
      // can never touch something they were never allowed to see. Selector
      // semantics live in domain/tool-targets so the group switches match on
      // the DERIVED category too — matching on groupLabel alone resolved zero
      // targets on exactly the servers groups were built for (cwpsa, cipp).
      if (body.tier || body.group !== undefined) {
        const targets = resolveToolTargets(repo, envelope, {
          upstreamId: body.upstreamId,
          ...(body.tier ? { tier: body.tier } : {}),
          ...(body.group !== undefined ? { group: body.group } : {}),
        });
        // Opt-in upstreams need explicit enabled rows; for normal ones
        // "enable" just deletes the personal deny.
        const optIn = repo.getUpstream(body.upstreamId)?.spec.userDefault === "off";
        const changed = repo.bulkSetUserPrefs(
          prefsIdentity(principal),
          body.upstreamId,
          targets.map((e) => e.upstreamToolName),
          body.enabled,
          optIn
        );
        me.onPolicyChanged();
        res.json({ ok: true, changed });
        return;
      }

      // Single tool (or the whole server via toolName ""), same opt-in rule.
      repo.bulkSetUserPrefs(
        prefsIdentity(principal),
        body.upstreamId,
        [body.toolName],
        body.enabled,
        repo.getUpstream(body.upstreamId)?.spec.userDefault === "off"
      );
      me.onPolicyChanged();
      res.json({ ok: true, changed: 1 });
    })
  );

  router.get(
    "/credentials",
    h((req, res) => {
      const rows = repo.listUserCredentials(prefsIdentity(req.principal!));
      res.json(rows.map(({ upstreamId, field, secretRef, updatedAt }) => ({ upstreamId, field, secretRef, updatedAt })));
    })
  );

  router.put(
    "/credentials/:upstreamId",
    h(async (req, res) => {
      const principal = req.principal!;
      if (!secretStore) {
        res.status(503).json({ error: "No secret store configured — set BAO_ADDR or KEY_VAULT_URI" });
        return;
      }
      const upstreamId = String(req.params.upstreamId ?? "");
      if (!repo.getUpstream(upstreamId)) {
        res.status(404).json({ error: `Unknown upstream "${upstreamId}"` });
        return;
      }
      const body = z
        .object({
          field: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/),
          value: z.string().min(1),
        })
        .parse(req.body);

      const path = `gw-user-${principalSlug(principal)}-${upstreamId}`;
      await secretStore.put(path, body.field, body.value);
      const ref = secretStore.refFor(path, body.field);
      repo.upsertUserCredential(prefsIdentity(principal), upstreamId, body.field, ref);
      // Never echo the value.
      res.json({ ok: true, ref });
    })
  );

  router.delete(
    "/credentials/:upstreamId/:field",
    h((req, res) => {
      const removed = repo.deleteUserCredential(
        prefsIdentity(req.principal!),
        String(req.params.upstreamId ?? ""),
        String(req.params.field ?? "")
      );
      // The secret store copy is left for rotation-history; re-registering
      // overwrites it. (Store-side cleanup can come with sessionMode.)
      res.json({ ok: removed });
    })
  );

  return router;
}
