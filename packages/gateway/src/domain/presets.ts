/**
 * Upstream presets: one-click installation of known MCP servers.
 *
 * A preset carries the FULL upstream spec (the parts the manual add form
 * cannot express: BYOK placeholder headers, toolsets, sessionMode,
 * userConnect, personalCredentials) as a template with `{{param}}` markers,
 * a mini-form declaration for the deployment-specific values, and
 * recommended role grants by ROLE NAME (role ids are per-deployment).
 *
 * Built-ins cover the MSPStack family (mcp-itglue / mcp-connectwise-psa /
 * mcp-planner) with the configuration proven in production; deployments add
 * their own via mspstack.presets.json (same shape, `{ "presets": [...] }`) —
 * on id collision the file wins so a deployment can also override a builtin.
 *
 * Substitution happens server-side at install time; the rendered spec goes
 * through the same parseUpstreamSpec validator as every other write path.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigError, parseUpstreamSpec, type UpstreamSpec } from "../config.js";
import type { MaxTier } from "./policy.js";

export const presetParamSchema = z.object({
  key: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/),
  label: z.string().min(1),
  placeholder: z.string().optional(),
  required: z.boolean().default(true),
  secret: z.boolean().default(false),
});

export const presetSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  description: z.string().min(1),
  params: z.array(presetParamSchema).default([]),
  /** Upstream spec template — validated AFTER param substitution. */
  spec: z.record(z.string(), z.unknown()),
  /** Recommended grants by role NAME; unknown names warn at install time. */
  grants: z.record(z.string(), z.enum(["none", "read", "write", "destructive"])).default({}),
});

export type PresetParam = z.infer<typeof presetParamSchema>;
export type Preset = z.infer<typeof presetSchema>;

/** What the catalog endpoint exposes (no spec template — the UI doesn't need it). */
export interface PresetSummary {
  id: string;
  title: string;
  description: string;
  params: PresetParam[];
  grants: Record<string, MaxTier>;
}

export const summarize = (p: Preset): PresetSummary => ({
  id: p.id,
  title: p.title,
  description: p.description,
  params: p.params,
  grants: p.grants as Record<string, MaxTier>,
});

// ── Built-in family presets (production-proven configuration) ───────────────

const DISCOVERY_PLACEHOLDER = "catalog-discovery-only";

export const BUILTIN_PRESETS: Preset[] = [
  presetSchema.parse({
    id: "itglue",
    title: "IT Glue (mcp-itglue)",
    description:
      "Documentation platform. One shared server-side API key — all calls run as the integration.",
    params: [
      { key: "url", label: "Server URL", placeholder: "https://mcp-itglue.example.com/mcp" },
      { key: "token", label: "MCP bearer token", secret: true },
    ],
    spec: {
      id: "itglue",
      namespace: "itglue",
      transport: "http",
      url: "{{url}}",
      headers: { Authorization: "Bearer {{token}}" },
    },
    grants: { viewer: "read", editor: "write" },
  }),
  presetSchema.parse({
    id: "cwpsa",
    title: "ConnectWise PSA (mcp-connectwise-psa)",
    description:
      "Tickets, time, scheduling. BYOK: each user registers their own member API keys on /me — writes are attributed to them.",
    params: [
      { key: "url", label: "Server URL", placeholder: "https://mcp-cwpsa.example.com/mcp" },
    ],
    spec: {
      id: "cwpsa",
      namespace: "cw",
      transport: "http",
      url: "{{url}}",
      headers: {
        "x-cw-public-key": DISCOVERY_PLACEHOLDER,
        "x-cw-private-key": DISCOVERY_PLACEHOLDER,
        "x-cw-toolsets": "all",
      },
      sessionMode: "per-user",
      requirePersonalCredentials: true,
      personalCredentials: [
        { field: "x-cw-public-key", label: "ConnectWise public key", secret: true },
        { field: "x-cw-private-key", label: "ConnectWise private key", secret: true },
        {
          field: "x-cw-member-id",
          label: "Member id",
          help: "Your ConnectWise member identifier (e.g. jdoe) — used by the \"my tickets / my time\" tools.",
        },
        {
          field: "x-cw-toolsets",
          label: "Toolsets",
          optional: true,
          help: "Comma list or preset: tech, dispatch, invoicing, all. Leave empty to use the server default.",
        },
      ],
    },
    grants: { viewer: "read", editor: "write" },
  }),
  presetSchema.parse({
    id: "planner",
    title: "Microsoft Planner (mcp-planner)",
    description:
      "Plans and tasks via Microsoft Graph. Users connect with one click (delegated — tasks are attributed to them).",
    params: [
      { key: "url", label: "Server URL", placeholder: "https://mcp-planner.example.com/mcp" },
      { key: "tenantId", label: "Entra tenant id" },
      {
        key: "connectClientId",
        label: "Entra PUBLIC client id (delegated Connect app)",
        placeholder: "app registration with delegated Tasks.ReadWrite + public client flows",
      },
    ],
    spec: {
      id: "planner",
      namespace: "planner",
      transport: "http",
      url: "{{url}}",
      headers: {
        "x-ms-tenant-id": "{{tenantId}}",
        "x-ms-client-id": DISCOVERY_PLACEHOLDER,
        "x-ms-client-secret": DISCOVERY_PLACEHOLDER,
      },
      sessionMode: "per-user",
      requirePersonalCredentials: true,
      userConnect: {
        kind: "entra-refresh-token",
        clientId: "{{connectClientId}}",
        scopes: "openid profile offline_access User.Read Tasks.ReadWrite Group.Read.All User.ReadBasic.All",
        tokenField: "x-ms-refresh-token",
        clientIdField: "x-ms-client-id",
        label: "Microsoft Planner",
      },
      personalCredentials: [
        { field: "x-ms-client-id", label: "Entra client id", help: "Filled automatically by the Connect button." },
        {
          field: "x-ms-refresh-token",
          label: "Refresh token",
          secret: true,
          help: "Filled automatically by the Connect button; paste manually only when using scripts/device-login.mjs.",
        },
        {
          field: "x-ms-client-secret",
          label: "Client secret",
          secret: true,
          optional: true,
          help: "Only for an app-only registration of your own — Connect (delegated) is the recommended path.",
        },
      ],
    },
    grants: { viewer: "read", editor: "write" },
  }),
];

// ── Loading + merging ────────────────────────────────────────────────────────

const presetsFileSchema = z.object({ presets: z.array(presetSchema).default([]) });

/**
 * Built-ins merged with the optional deployment file. A file preset with the
 * same id REPLACES the builtin (deployments can pin their own variants).
 * A missing file is fine; a malformed one is a hard ConfigError — same
 * posture as mspstack.config.json.
 */
export function loadPresets(filePath: string): Preset[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [...BUILTIN_PRESETS];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Presets file ${filePath} is not valid JSON: ${String(err)}`);
  }
  const parsed = presetsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`Invalid presets file ${filePath}: ${parsed.error.message}`);
  }
  const merged = new Map(BUILTIN_PRESETS.map((p) => [p.id, p]));
  for (const preset of parsed.data.presets) {
    if (merged.has(preset.id)) {
      console.error(`[presets] "${preset.id}" from ${filePath} overrides the builtin`);
    }
    merged.set(preset.id, preset);
  }
  return [...merged.values()];
}

// ── Rendering ────────────────────────────────────────────────────────────────

const PARAM_RE = /\{\{([A-Za-z0-9_-]+)\}\}/g;

/**
 * Substitute `{{param}}` markers throughout the spec template and validate
 * the result. Missing required params and unresolved markers are hard
 * errors — a half-rendered spec must never reach the database.
 */
export function renderPreset(preset: Preset, values: Record<string, string>): UpstreamSpec {
  for (const param of preset.params) {
    if (param.required && !values[param.key]?.trim()) {
      throw new ConfigError(`Missing required parameter "${param.key}" (${param.label})`);
    }
  }
  const known = new Set(preset.params.map((p) => p.key));

  const substitute = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.replace(PARAM_RE, (marker, key: string) => {
        if (!known.has(key)) {
          throw new ConfigError(`Spec template references undeclared parameter ${marker}`);
        }
        return values[key]?.trim() ?? "";
      });
    }
    if (Array.isArray(node)) return node.map(substitute);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v)]));
    }
    return node;
  };

  return parseUpstreamSpec(substitute(preset.spec));
}
