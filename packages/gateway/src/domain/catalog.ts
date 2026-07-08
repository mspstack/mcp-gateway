/**
 * Tool catalog: namespacing, routing, and tier derivation.
 *
 * Every upstream tool is exposed under `${namespace}_${name}`; tools that
 * already carry the namespace prefix (the mcp-itglue family names its tools
 * `itglue_*` etc.) are exposed as-is instead of being double-prefixed.
 * Routing never string-splits — a routing table maps each exposed name back
 * to its (upstream, original tool name) pair, so collisions are detected at
 * catalog-build time and later upstreams lose deterministically.
 *
 * Tiers mirror mcp-itglue's src/auth/roles.ts: derived from MCP annotations
 * (readOnlyHint → read, destructiveHint → destructive, else write). They are
 * recorded now so the M3 policy engine has data to act on.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type Tier = "read" | "write" | "destructive";

export function tierOf(annotations: Tool["annotations"]): Tier {
  if (annotations?.readOnlyHint === true) return "read";
  if (annotations?.destructiveHint === true) return "destructive";
  return "write";
}

export function exposedNameFor(namespace: string, toolName: string): string {
  return toolName.startsWith(`${namespace}_`) ? toolName : `${namespace}_${toolName}`;
}

export interface CatalogEntry {
  upstreamId: string;
  namespace: string;
  /** The tool name as the upstream knows it. */
  upstreamToolName: string;
  /** The namespaced name shown to gateway clients. */
  exposedName: string;
  tier: Tier;
  tool: Tool;
}

export interface UpstreamTools {
  upstreamId: string;
  namespace: string;
  tools: Tool[];
}

/**
 * Build the catalog from per-upstream tool lists. On an exposed-name
 * collision the first entry wins and the loser is reported (the caller logs
 * it); upstreams are processed in declaration order so behavior is stable.
 */
export function buildCatalog(upstreams: UpstreamTools[]): {
  entries: Map<string, CatalogEntry>;
  collisions: string[];
} {
  const entries = new Map<string, CatalogEntry>();
  const collisions: string[] = [];

  for (const { upstreamId, namespace, tools } of upstreams) {
    for (const tool of tools) {
      const exposedName = exposedNameFor(namespace, tool.name);
      const existing = entries.get(exposedName);
      if (existing) {
        collisions.push(
          `"${exposedName}" from upstream "${upstreamId}" collides with upstream "${existing.upstreamId}" — keeping the first`
        );
        continue;
      }
      entries.set(exposedName, {
        upstreamId,
        namespace,
        upstreamToolName: tool.name,
        exposedName,
        tier: tierOf(tool.annotations),
        tool,
      });
    }
  }

  return { entries, collisions };
}

/** The tool list served to gateway clients, renamed to exposed names. */
export function exposedTools(entries: Map<string, CatalogEntry>): Tool[] {
  return [...entries.values()].map((entry) => ({ ...entry.tool, name: entry.exposedName }));
}
