/**
 * Resolving "which tools does this bulk action touch" — shared by the admin
 * API, the /me prefs API, and the self-management MCP toolset so the three can
 * never disagree about what a tier or group selector means.
 *
 * Targets always come from the LIVE catalog (and, for user-facing callers, from
 * the caller's own envelope), so a stale UI or a guessing client cannot create
 * settings rows for tools that don't exist or were never visible to it.
 */

import type { Repo } from "../db/repo.js";
import type { CatalogEntry, Tier } from "./catalog.js";
import { derivedGroupOf } from "./catalog.js";

export interface ToolSelector {
  upstreamId: string;
  /** Effective tier (override ?? derived) — what the UI displays. */
  tier?: Tier;
  /** Explicit group label, else the category derived from the description. */
  group?: string;
  /** A single tool; "" means the whole upstream (prefs use that convention). */
  toolName?: string;
}

/** Effective tier of an entry: an admin override wins over the annotation. */
export const effectiveTierOf = (repo: Repo, entry: CatalogEntry): Tier =>
  repo.toolSetting(entry.upstreamId, entry.upstreamToolName)?.tierOverride ?? entry.tier;

/** Effective group: explicit label wins over the derived category. */
export const effectiveGroupOf = (repo: Repo, entry: CatalogEntry): string =>
  repo.toolSetting(entry.upstreamId, entry.upstreamToolName)?.groupLabel ??
  derivedGroupOf(entry.tool) ??
  "";

/**
 * Filter `entries` down to the selector's targets. `entries` is whatever the
 * caller is allowed to act on: the whole catalog for admins, the principal's
 * visible envelope for /me.
 */
export function resolveToolTargets(
  repo: Repo,
  entries: Iterable<CatalogEntry>,
  selector: ToolSelector
): CatalogEntry[] {
  const targets: CatalogEntry[] = [];
  for (const entry of entries) {
    if (entry.upstreamId !== selector.upstreamId) continue;
    if (selector.toolName !== undefined && selector.toolName !== "" && entry.upstreamToolName !== selector.toolName) {
      continue;
    }
    if (selector.tier && effectiveTierOf(repo, entry) !== selector.tier) continue;
    if (selector.group !== undefined && effectiveGroupOf(repo, entry) !== selector.group) continue;
    targets.push(entry);
  }
  return targets;
}
