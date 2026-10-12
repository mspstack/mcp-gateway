/**
 * Usage statistics for the admin Usage tab: who calls which MCP servers and
 * tools, and how many live sessions each principal holds. Built from the
 * daily aggregate rows (`tool_usage_daily`) plus the in-memory session table.
 * Pure — no I/O — so the shape is testable without a database or a server.
 */

import type { ToolUsageRow } from "../db/repo.js";

/** What the session table exposes per live session (see app.ts sessionSummaries). */
export interface LiveSessionInfo {
  principal: string;
  label: string;
  streamOpen: boolean;
  client?: string;
  lastSeen?: string;
}

interface Counts {
  calls: number;
  errors: number;
  denied: number;
  totalMs: number;
  lastAt: string | null;
}

const empty = (): Counts => ({ calls: 0, errors: 0, denied: 0, totalMs: 0, lastAt: null });

function add(into: Counts, row: ToolUsageRow): void {
  into.calls += row.calls;
  into.errors += row.errors;
  into.denied += row.denied;
  into.totalMs += row.totalMs;
  if (into.lastAt === null || row.lastAt > into.lastAt) into.lastAt = row.lastAt;
}

const avgMs = (c: Counts): number | null => (c.calls > 0 ? Math.round(c.totalMs / c.calls) : null);

/** UTC day string (YYYY-MM-DD) `days - 1` days before `now` — the window's first day. */
export function usageSinceDay(days: number, now = new Date()): string {
  return new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

export function summarizeUsage(
  rows: ToolUsageRow[],
  sessions: LiveSessionInfo[],
  days: number,
  now = new Date()
) {
  const since = usageSinceDay(days, now);
  const inWindow = rows.filter((r) => r.day >= since);

  const totals = empty();
  const byDay = new Map<string, Counts>();
  const byUser = new Map<string, Counts & { label: string; upstreams: Map<string, number> }>();
  const byUpstream = new Map<string, Counts & { users: Set<string> }>();
  const byTool = new Map<string, Counts & { upstreamId: string; toolName: string; users: Set<string> }>();

  for (const row of inWindow) {
    add(totals, row);

    const day = byDay.get(row.day) ?? empty();
    add(day, row);
    byDay.set(row.day, day);

    let user = byUser.get(row.principal);
    if (!user) {
      user = { ...empty(), label: row.label, upstreams: new Map() };
      byUser.set(row.principal, user);
    }
    // Keep the most recent label — emails change less often than display names.
    if (user.lastAt === null || row.lastAt >= user.lastAt) user.label = row.label;
    add(user, row);
    user.upstreams.set(row.upstreamId, (user.upstreams.get(row.upstreamId) ?? 0) + row.calls + row.denied);

    let upstream = byUpstream.get(row.upstreamId);
    if (!upstream) {
      upstream = { ...empty(), users: new Set() };
      byUpstream.set(row.upstreamId, upstream);
    }
    add(upstream, row);
    upstream.users.add(row.principal);

    const toolKey = `${row.upstreamId}\u0000${row.toolName}`;
    let tool = byTool.get(toolKey);
    if (!tool) {
      tool = { ...empty(), upstreamId: row.upstreamId, toolName: row.toolName, users: new Set() };
      byTool.set(toolKey, tool);
    }
    add(tool, row);
    tool.users.add(row.principal);
  }

  // Live sessions, grouped by principal and by the client that opened them.
  const sessionsByPrincipal = new Map<
    string,
    { label: string; count: number; streamsOpen: number; clients: Map<string, number>; lastSeen: string | null }
  >();
  for (const s of sessions) {
    let group = sessionsByPrincipal.get(s.principal);
    if (!group) {
      group = { label: s.label, count: 0, streamsOpen: 0, clients: new Map(), lastSeen: null };
      sessionsByPrincipal.set(s.principal, group);
    }
    group.count += 1;
    if (s.streamOpen) group.streamsOpen += 1;
    const client = s.client ?? "unknown client";
    group.clients.set(client, (group.clients.get(client) ?? 0) + 1);
    if (s.lastSeen && (group.lastSeen === null || s.lastSeen > group.lastSeen)) group.lastSeen = s.lastSeen;
  }

  // Every day of the window, zero-filled, so the chart has no gaps.
  const daily: Array<{ day: string; calls: number; errors: number; denied: number }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const c = byDay.get(day) ?? empty();
    daily.push({ day, calls: c.calls, errors: c.errors, denied: c.denied });
  }

  const byCallsDesc = <T extends { calls: number; denied: number }>(a: T, b: T) =>
    b.calls + b.denied - (a.calls + a.denied);

  return {
    days,
    since,
    totals: {
      calls: totals.calls,
      errors: totals.errors,
      denied: totals.denied,
      users: byUser.size,
      liveSessions: sessions.length,
    },
    daily,
    users: [...byUser.entries()]
      .map(([principal, u]) => ({
        principal,
        label: u.label,
        calls: u.calls,
        errors: u.errors,
        denied: u.denied,
        avgMs: avgMs(u),
        lastAt: u.lastAt,
        upstreams: [...u.upstreams.entries()]
          .map(([upstreamId, calls]) => ({ upstreamId, calls }))
          .sort((a, b) => b.calls - a.calls),
        liveSessions: sessionsByPrincipal.get(principal)?.count ?? 0,
      }))
      .sort(byCallsDesc),
    upstreams: [...byUpstream.entries()]
      .map(([upstreamId, u]) => ({
        upstreamId,
        calls: u.calls,
        errors: u.errors,
        denied: u.denied,
        avgMs: avgMs(u),
        users: u.users.size,
        lastAt: u.lastAt,
      }))
      .sort(byCallsDesc),
    tools: [...byTool.values()]
      .map((t) => ({
        upstreamId: t.upstreamId,
        toolName: t.toolName,
        calls: t.calls,
        errors: t.errors,
        denied: t.denied,
        avgMs: avgMs(t),
        users: t.users.size,
      }))
      .sort(byCallsDesc)
      .slice(0, 50),
    sessions: {
      total: sessions.length,
      streamsOpen: sessions.filter((s) => s.streamOpen).length,
      byPrincipal: [...sessionsByPrincipal.entries()]
        .map(([principal, g]) => ({
          principal,
          label: g.label,
          count: g.count,
          streamsOpen: g.streamsOpen,
          lastSeen: g.lastSeen,
          clients: [...g.clients.entries()]
            .map(([client, count]) => ({ client, count }))
            .sort((a, b) => b.count - a.count),
        }))
        .sort((a, b) => b.count - a.count),
    },
  };
}
