import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { Repo, USAGE_RETENTION_DAYS, type ToolUsageEvent } from "../db/repo.js";
import { summarizeUsage, usageSinceDay } from "./usage.js";

const NOW = new Date("2026-10-12T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const event = (overrides: Partial<ToolUsageEvent> = {}): ToolUsageEvent => ({
  principal: "oidc:iss|alice",
  label: "alice@example.com",
  upstreamId: "cwpsa",
  toolName: "get_ticket",
  outcome: "ok",
  durationMs: 100,
  ...overrides,
});

describe("tool usage statistics", () => {
  it("aggregates calls into one row per day, principal, upstream and tool", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.recordToolUsage(event({ durationMs: 100 }), NOW);
    repo.recordToolUsage(event({ durationMs: 300, outcome: "error" }), NOW);
    repo.recordToolUsage(event({ outcome: "denied", durationMs: 0 }), NOW);

    const rows = repo.toolUsageSince("2026-10-12");
    expect(rows).toHaveLength(1);
    // A denial never reached the upstream: counted apart, not as a call.
    expect(rows[0]).toMatchObject({ calls: 2, errors: 1, denied: 1, totalMs: 400 });
  });

  it("prunes rows past the retention window", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.recordToolUsage(event(), daysAgo(USAGE_RETENTION_DAYS + 5));
    repo.recordToolUsage(event(), NOW); // first call of a new day triggers the prune
    expect(repo.toolUsageSince("2000-01-01").map((r) => r.day)).toEqual(["2026-10-12"]);
  });

  it("summarizes by user, server and tool, with zero-filled days and live sessions", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.recordToolUsage(event(), NOW);
    repo.recordToolUsage(event(), daysAgo(2));
    repo.recordToolUsage(event({ upstreamId: "itglue", toolName: "get_document" }), NOW);
    repo.recordToolUsage(event({ principal: "oidc:iss|bob", label: "bob@example.com" }), NOW);
    repo.recordToolUsage(event(), daysAgo(10)); // outside a 7-day window

    const summary = summarizeUsage(
      repo.toolUsageSince(usageSinceDay(7, NOW)),
      [
        { principal: "oidc:iss|bob", label: "bob@example.com", streamOpen: false, client: "openai-mcp/1.0" },
        { principal: "oidc:iss|bob", label: "bob@example.com", streamOpen: true, client: "openai-mcp/1.0" },
      ],
      7,
      NOW
    );

    expect(summary.totals).toMatchObject({ calls: 4, users: 2, liveSessions: 2 });
    expect(summary.daily).toHaveLength(7);
    expect(summary.daily.at(-1)).toMatchObject({ day: "2026-10-12", calls: 3 });
    expect(summary.daily.at(-3)).toMatchObject({ day: "2026-10-10", calls: 1 });

    expect(summary.users[0]).toMatchObject({ label: "alice@example.com", calls: 3, liveSessions: 0 });
    expect(summary.users[0]!.upstreams).toEqual([
      { upstreamId: "cwpsa", calls: 2 },
      { upstreamId: "itglue", calls: 1 },
    ]);
    expect(summary.upstreams[0]).toMatchObject({ upstreamId: "cwpsa", calls: 3, users: 2, avgMs: 100 });
    expect(summary.tools[0]).toMatchObject({ upstreamId: "cwpsa", toolName: "get_ticket", calls: 3 });

    expect(summary.sessions.byPrincipal).toEqual([
      expect.objectContaining({
        label: "bob@example.com",
        count: 2,
        streamsOpen: 1,
        clients: [{ client: "openai-mcp/1.0", count: 2 }],
      }),
    ]);
  });
});
