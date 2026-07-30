/**
 * Self-management toolset: administer the gateway through its own protocol
 * (issue #2), so a "turn off CIPP's destructive tools" or "what's connected?"
 * is a sentence in Claude Code instead of a browser trip.
 *
 * Boundaries, deliberately narrow:
 *  - ADMIN ONLY. The tools are hidden from tools/list for everyone else, and
 *    every call re-checks `principal.isAdmin` (list filtering is UX, the call
 *    check is the boundary). A non-admin gets the same "not available" text a
 *    non-existent tool gets — no oracle for what exists.
 *  - The `gw` namespace is reserved (config.ts rejects it for upstreams), so a
 *    federated server can never shadow these names or be shadowed by them.
 *  - Secrets never come back out: server specs are returned with header/env
 *    VALUES redacted, keys and ref-vs-literal shape only.
 *  - No credential writes, no user impersonation, no secret reads — those stay
 *    on the HTTP admin surface where the browser session gates them.
 */

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DatabaseSync } from "node:sqlite";
import type { GatewayConfig, UpstreamSpec } from "../config.js";
import type { Repo } from "../db/repo.js";
import type { Preset } from "../domain/presets.js";
import type { PolicyService, Tier } from "../domain/policy.js";
import type { UpstreamManager } from "../upstream/manager.js";
import type { Principal } from "../auth/principal.js";
import { isMaxTier } from "../domain/policy.js";
import { renderPreset } from "../domain/presets.js";
import { effectiveGroupOf, effectiveTierOf, resolveToolTargets } from "../domain/tool-targets.js";
import { runBackup } from "../db/backup.js";
import type { BackupUploader } from "../db/backup.js";

/** Reserved namespace: `config.ts` refuses it for upstreams. */
export const SELF_NAMESPACE = "gw";

/** Cap on how many tool rows one listing returns — keep responses readable. */
const LIST_CAP = 150;

export interface SelfToolDeps {
  config: GatewayConfig;
  repo: Repo;
  manager: UpstreamManager;
  policy: PolicyService;
  presets: Preset[];
  db?: DatabaseSync;
  backupUploader?: BackupUploader;
  /** Re-broadcast tools/list_changed after a change (same hook the API uses). */
  onPolicyChanged: () => void;
}

const text = (body: string): CallToolResult => ({ content: [{ type: "text", text: body }] });
const failure = (body: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: body }] });
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));

/** Header/env values can be literal secrets — never echo them back. */
function redactInjection(record: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => [
      key,
      /^(bao:|kv:)/.test(value) ? `ref ${value}` : value.includes("${") ? `env ${value}` : "(literal, redacted)",
    ])
  );
}

function describeSpec(spec: UpstreamSpec, source: string) {
  const shared = {
    id: spec.id,
    namespace: spec.namespace,
    transport: spec.transport,
    enabled: spec.enabled,
    source,
    sessionMode: spec.sessionMode,
    requirePersonalCredentials: spec.requirePersonalCredentials,
    userDefault: spec.userDefault,
    mintsOwnToken: Boolean(spec.auth),
    offersUserConnect: Boolean(spec.userConnect),
  };
  return spec.transport === "http"
    ? { ...shared, url: spec.url, headers: redactInjection(spec.headers) }
    : { ...shared, command: spec.command, args: spec.args, env: redactInjection(spec.env) };
}

const TIER_ENUM = ["read", "write", "destructive"] as const;

/** The tool definitions, in the shape tools/list returns them. */
export const SELF_TOOLS: Tool[] = [
  {
    name: `${SELF_NAMESPACE}_status`,
    description:
      "Gateway health: version, connected upstreams with tool counts and last errors, catalog size, secret-store scheme, auth mode.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_list_servers`,
    description:
      "Configured upstream MCP servers with their mode flags. Header/env values are redacted — only keys and whether the value is a secret ref, an env ref, or a literal.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_list_tools`,
    description:
      "Tools in the catalog with their effective tier, group and enabled state. Filter by upstream, tier, group, enabled state, or a name substring.",
    inputSchema: {
      type: "object",
      properties: {
        upstreamId: { type: "string", description: "Only this upstream." },
        tier: { type: "string", enum: [...TIER_ENUM], description: "Only this effective tier." },
        group: { type: "string", description: "Only this group/category." },
        enabled: { type: "boolean", description: "Only enabled (true) or only disabled (false) tools." },
        query: { type: "string", description: "Case-insensitive substring of the tool name." },
        groupsOnly: {
          type: "boolean",
          description: "Return a per-group summary (counts by tier) instead of individual tools.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_set_tools_enabled`,
    description:
      "Enable or disable tools for EVERYONE (the admin envelope, not a personal preference). Scope with tier and/or group, a single toolName, or neither for the whole upstream.",
    inputSchema: {
      type: "object",
      properties: {
        upstreamId: { type: "string" },
        enabled: { type: "boolean" },
        tier: { type: "string", enum: [...TIER_ENUM] },
        group: { type: "string" },
        toolName: { type: "string" },
      },
      required: ["upstreamId", "enabled"],
      additionalProperties: false,
    },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_set_tool_tier`,
    description:
      "Override a tool's tier (read/write/destructive), or clear the override to fall back to the annotation-derived tier. Raising the tier is how a read-only tool that hands out secrets is kept away from low roles.",
    inputSchema: {
      type: "object",
      properties: {
        upstreamId: { type: "string" },
        toolName: { type: "string" },
        tier: { type: ["string", "null"], enum: [...TIER_ENUM, null], description: "null clears the override." },
      },
      required: ["upstreamId", "toolName"],
      additionalProperties: false,
    },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_set_grant`,
    description:
      "Set a role's ceiling for one upstream by role NAME: none / read / write / destructive. 'none' closes the upstream for that role.",
    inputSchema: {
      type: "object",
      properties: {
        roleName: { type: "string" },
        upstreamId: { type: "string" },
        maxTier: { type: "string", enum: ["none", ...TIER_ENUM] },
      },
      required: ["roleName", "upstreamId", "maxTier"],
      additionalProperties: false,
    },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_list_presets`,
    description: "Installable server presets: id, title, description, the parameters each one needs, and its recommended grants.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_install_preset`,
    description:
      "Install (or re-install) an upstream from a preset. Secret parameters must be REFERENCES (kv:/bao:/${ENV}) — never a raw secret, which would end up stored in the spec.",
    inputSchema: {
      type: "object",
      properties: {
        presetId: { type: "string" },
        params: { type: "object", additionalProperties: { type: "string" } },
        dryRun: { type: "boolean", description: "Render and validate the spec without saving." },
      },
      required: ["presetId"],
      additionalProperties: false,
    },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_set_server_enabled`,
    description: "Enable or disable a whole upstream server (its tools disappear from every session while disabled).",
    inputSchema: {
      type: "object",
      properties: { upstreamId: { type: "string" }, enabled: { type: "boolean" } },
      required: ["upstreamId", "enabled"],
      additionalProperties: false,
    },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_remove_server`,
    description:
      "Remove an upstream and everything attached to it: tool settings, per-role grants and overrides. Personal credentials for it are orphaned, not deleted.",
    inputSchema: {
      type: "object",
      properties: { upstreamId: { type: "string" }, confirm: { type: "boolean", description: "Must be true." } },
      required: ["upstreamId", "confirm"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_refresh_catalog`,
    description: "Re-read every upstream's tool list now (also happens automatically on list_changed and after reconnects).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    _meta: { group: "gateway" },
  },
  {
    name: `${SELF_NAMESPACE}_backup_now`,
    description: "Take a database snapshot immediately (VACUUM INTO), prune to the retention limit, and ship it off-instance when configured.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    _meta: { group: "gateway" },
  },
];

const SELF_TOOL_NAMES = new Set(SELF_TOOLS.map((t) => t.name));
export const isSelfTool = (name: string): boolean => SELF_TOOL_NAMES.has(name);

type Args = Record<string, unknown>;
const str = (args: Args, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;
const bool = (args: Args, key: string): boolean | undefined =>
  typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;

/**
 * Execute a self-management tool. Returns null when `name` isn't one of ours,
 * so the caller can fall through to the federated catalog.
 */
export async function callSelfTool(
  deps: SelfToolDeps,
  principal: Principal,
  name: string,
  args: Args
): Promise<CallToolResult | null> {
  if (!isSelfTool(name)) return null;
  // The boundary: never trust that the list filter kept a non-admin away.
  if (!principal.isAdmin) {
    return failure(
      `Tool "${name}" is not available to this session — it may not exist, be disabled, or require a higher role than "${principal.roleName}".`
    );
  }

  const { config, repo, manager, presets } = deps;
  const entries = () => [...manager.catalogEntries()];

  switch (name) {
    case `${SELF_NAMESPACE}_status`:
      return json({
        version: config.mode === "integrated" ? "integrated" : "standalone",
        toolCount: entries().length,
        upstreams: manager.summaries(),
        secretStore: config.bao ? "openbao" : config.keyVault ? "keyvault" : null,
        auth: {
          staticTokenLabels: config.staticTokens.map((t) => t.label),
          oidcIssuer: config.oidc?.issuer ?? null,
          interactiveLogin: Boolean(config.login),
        },
        backups: { dir: config.backup.dir, keep: config.backup.keep, intervalHours: config.backup.intervalHours },
      });

    case `${SELF_NAMESPACE}_list_servers`:
      return json(repo.listUpstreams().map((row) => describeSpec(row.spec, row.source)));

    case `${SELF_NAMESPACE}_list_tools`: {
      const upstreamId = str(args, "upstreamId");
      const tier = str(args, "tier") as Tier | undefined;
      const group = str(args, "group");
      const wantEnabled = bool(args, "enabled");
      const query = str(args, "query")?.toLowerCase();
      const rows = entries()
        .filter((e) => !upstreamId || e.upstreamId === upstreamId)
        .map((e) => ({
          upstreamId: e.upstreamId,
          toolName: e.upstreamToolName,
          exposedName: e.exposedName,
          tier: effectiveTierOf(repo, e),
          group: effectiveGroupOf(repo, e),
          enabled: repo.toolSetting(e.upstreamId, e.upstreamToolName)?.enabled ?? true,
        }))
        .filter((r) => !tier || r.tier === tier)
        .filter((r) => group === undefined || r.group === group)
        .filter((r) => wantEnabled === undefined || r.enabled === wantEnabled)
        .filter((r) => !query || r.exposedName.toLowerCase().includes(query));

      if (bool(args, "groupsOnly")) {
        const summary = new Map<string, { upstreamId: string; group: string; read: number; write: number; destructive: number; enabled: number; total: number }>();
        for (const r of rows) {
          const key = `${r.upstreamId}/${r.group}`;
          const s = summary.get(key) ?? { upstreamId: r.upstreamId, group: r.group || "(ungrouped)", read: 0, write: 0, destructive: 0, enabled: 0, total: 0 };
          s[r.tier] += 1;
          s.total += 1;
          if (r.enabled) s.enabled += 1;
          summary.set(key, s);
        }
        return json({ groups: [...summary.values()] });
      }
      return json({
        total: rows.length,
        shown: Math.min(rows.length, LIST_CAP),
        tools: rows.slice(0, LIST_CAP),
        ...(rows.length > LIST_CAP ? { note: `${rows.length - LIST_CAP} more — narrow with upstreamId/tier/group/query, or use groupsOnly.` } : {}),
      });
    }

    case `${SELF_NAMESPACE}_set_tools_enabled`: {
      const upstreamId = str(args, "upstreamId")!;
      const enabled = bool(args, "enabled")!;
      const targets = resolveToolTargets(repo, entries(), {
        upstreamId,
        ...(str(args, "tier") ? { tier: str(args, "tier") as Tier } : {}),
        ...(str(args, "group") !== undefined ? { group: str(args, "group")! } : {}),
        ...(str(args, "toolName") ? { toolName: str(args, "toolName")! } : {}),
      });
      if (targets.length === 0) {
        return failure(`Nothing matched in upstream "${upstreamId}" — check the id, tier and group with ${SELF_NAMESPACE}_list_tools.`);
      }
      const changed = repo.bulkSetToolEnabled(upstreamId, targets.map((e) => e.upstreamToolName), enabled);
      deps.onPolicyChanged();
      return text(`${enabled ? "Enabled" : "Disabled"} ${changed} tool(s) in "${upstreamId}" for every role.`);
    }

    case `${SELF_NAMESPACE}_set_tool_tier`: {
      const upstreamId = str(args, "upstreamId")!;
      const toolName = str(args, "toolName")!;
      const tier = args.tier === null ? null : (str(args, "tier") as Tier | undefined);
      if (tier === undefined) return failure("Provide tier (read/write/destructive) or null to clear the override.");
      if (!entries().some((e) => e.upstreamId === upstreamId && e.upstreamToolName === toolName)) {
        return failure(`Tool "${toolName}" is not in upstream "${upstreamId}"'s catalog.`);
      }
      repo.upsertToolSetting({ upstreamId, toolName, tierOverride: tier });
      deps.onPolicyChanged();
      return text(tier ? `"${toolName}" is now tier ${tier}.` : `"${toolName}" is back to its derived tier.`);
    }

    case `${SELF_NAMESPACE}_set_grant`: {
      const roleName = str(args, "roleName")!;
      const upstreamId = str(args, "upstreamId")!;
      const maxTier = str(args, "maxTier")!;
      if (!isMaxTier(maxTier)) return failure(`maxTier must be none/read/write/destructive, got "${maxTier}".`);
      const role = repo.roleByName(roleName);
      if (!role) {
        return failure(`No role named "${roleName}" — existing roles: ${repo.listRoles().map((r) => r.name).join(", ")}.`);
      }
      repo.setGrant(role.id, upstreamId, maxTier);
      deps.onPolicyChanged();
      return text(`Role "${roleName}" now has ceiling "${maxTier}" on "${upstreamId}".`);
    }

    case `${SELF_NAMESPACE}_list_presets`:
      return json(
        presets.map((p) => ({ id: p.id, title: p.title, description: p.description, params: p.params, grants: p.grants }))
      );

    case `${SELF_NAMESPACE}_install_preset`: {
      const presetId = str(args, "presetId")!;
      const preset = presets.find((p) => p.id === presetId);
      if (!preset) return failure(`No preset "${presetId}" — see ${SELF_NAMESPACE}_list_presets.`);
      const params = (args.params ?? {}) as Record<string, string>;
      let spec: UpstreamSpec;
      try {
        spec = renderPreset(preset, params);
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
      if (bool(args, "dryRun")) return json({ dryRun: true, spec: describeSpec(spec, "preset") });
      repo.upsertUpstream(spec, "api");
      await manager.upsertUpstream(spec);
      const applied: string[] = [];
      const warnings: string[] = [];
      for (const [roleName, maxTier] of Object.entries(preset.grants)) {
        const role = repo.roleByName(roleName);
        if (!role) {
          warnings.push(`role "${roleName}" does not exist — grant "${maxTier}" skipped`);
          continue;
        }
        repo.setGrant(role.id, spec.id, maxTier);
        applied.push(`${roleName}=${maxTier}`);
      }
      deps.onPolicyChanged();
      return json({ installed: spec.id, grants: applied, warnings });
    }

    case `${SELF_NAMESPACE}_set_server_enabled`: {
      const upstreamId = str(args, "upstreamId")!;
      const enabled = bool(args, "enabled")!;
      if (!repo.setUpstreamEnabled(upstreamId, enabled)) return failure(`No upstream "${upstreamId}".`);
      await manager.upsertUpstream(repo.getUpstream(upstreamId)!.spec);
      deps.onPolicyChanged();
      return text(`Upstream "${upstreamId}" is now ${enabled ? "enabled" : "disabled"}.`);
    }

    case `${SELF_NAMESPACE}_remove_server`: {
      const upstreamId = str(args, "upstreamId")!;
      if (bool(args, "confirm") !== true) {
        return failure(`Refusing to remove "${upstreamId}" without confirm: true.`);
      }
      const existed = repo.deleteUpstream(upstreamId);
      await manager.removeUpstream(upstreamId);
      deps.onPolicyChanged();
      return text(
        existed
          ? `Removed "${upstreamId}" with its tool settings, grants and overrides. Personal credentials for it are now orphaned.`
          : `No upstream "${upstreamId}" — nothing to remove.`
      );
    }

    case `${SELF_NAMESPACE}_refresh_catalog`: {
      await manager.refreshCatalog();
      const perUpstream = Object.fromEntries(manager.summaries().map((s) => [s.id, s.toolCount]));
      deps.onPolicyChanged();
      return json({ toolCount: entries().length, perUpstream });
    }

    case `${SELF_NAMESPACE}_backup_now`: {
      if (!deps.db) return failure("No database handle available for backups in this process.");
      const file = await runBackup(deps.db, config.backup, deps.backupUploader);
      return json({ name: file.name, sizeBytes: file.sizeBytes, createdAt: file.createdAt, dir: config.backup.dir });
    }

    default:
      return failure(`Tool "${name}" is not implemented.`);
  }
}
