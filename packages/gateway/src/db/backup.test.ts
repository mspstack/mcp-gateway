import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "./index.js";
import { Repo } from "./repo.js";
import { listSnapshots, pruneSnapshots, runBackup, snapshot, startBackupSchedule } from "./backup.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "gw-backup-"));

/** A real on-disk gateway db with something worth backing up. */
function seededDb(dir: string) {
  const db = openDatabase(join(dir, "gateway.db"));
  const repo = new Repo(db);
  repo.upsertUpstream(
    { id: "cipp", namespace: "cipp", transport: "http", url: "https://cipp/mcp", headers: {}, enabled: true } as never,
    "api"
  );
  repo.setGroupMapping("https://idp", "group-guid", repo.roleByName("admin")!.id);
  return { db, repo };
}

describe("snapshot", () => {
  it("writes a queryable copy of the live database", () => {
    const dir = freshDir();
    const { db } = seededDb(dir);
    const file = snapshot(db, join(dir, "backups"), new Date("2026-07-29T15:04:05.123Z"));

    expect(file.name).toBe("gateway-backup-2026-07-29T15-04-05-123Z.db");
    expect(file.sizeBytes).toBeGreaterThan(0);

    // The snapshot is a real database, not a torn file: open it and read back.
    const restored = new DatabaseSync(file.path);
    const rows = restored.prepare("SELECT id FROM upstreams").all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["cipp"]);
    expect((restored.prepare("SELECT COUNT(*) c FROM group_mappings").get() as { c: number }).c).toBe(1);
    restored.close();
    db.close();
  });

  it("keeps serving while the snapshot is taken (writes after it are not lost)", () => {
    const dir = freshDir();
    const { db, repo } = seededDb(dir);
    snapshot(db, join(dir, "backups"));
    repo.createRole("post-backup", "read"); // db still usable
    expect(repo.roleByName("post-backup")).not.toBeNull();
    db.close();
  });
});

describe("listSnapshots / pruneSnapshots", () => {
  it("lists newest first and ignores foreign files", () => {
    const dir = freshDir();
    const { db } = seededDb(dir);
    const backups = join(dir, "backups");
    snapshot(db, backups, new Date("2026-07-01T00:00:00Z"));
    snapshot(db, backups, new Date("2026-07-03T00:00:00Z"));
    snapshot(db, backups, new Date("2026-07-02T00:00:00Z"));
    writeFileSync(join(backups, "notes.txt"), "not a backup");

    const listed = listSnapshots(backups);
    expect(listed.map((f) => f.name)).toEqual([
      "gateway-backup-2026-07-03T00-00-00-000Z.db",
      "gateway-backup-2026-07-02T00-00-00-000Z.db",
      "gateway-backup-2026-07-01T00-00-00-000Z.db",
    ]);
    db.close();
  });

  it("prunes the oldest beyond `keep`", () => {
    const dir = freshDir();
    const { db } = seededDb(dir);
    const backups = join(dir, "backups");
    for (const day of ["01", "02", "03", "04"]) {
      snapshot(db, backups, new Date(`2026-07-${day}T00:00:00Z`));
    }
    const removed = pruneSnapshots(backups, 2);
    expect(removed).toEqual([
      "gateway-backup-2026-07-02T00-00-00-000Z.db",
      "gateway-backup-2026-07-01T00-00-00-000Z.db",
    ]);
    expect(listSnapshots(backups)).toHaveLength(2);
    db.close();
  });

  it("returns [] for a directory that doesn't exist yet", () => {
    expect(listSnapshots(join(freshDir(), "nope"))).toEqual([]);
  });
});

describe("runBackup", () => {
  it("snapshots, prunes, and ships the file off-instance", async () => {
    const dir = freshDir();
    const { db } = seededDb(dir);
    const backups = join(dir, "backups");
    const uploaded: Array<{ name: string; bytes: number }> = [];
    const upload = async (localPath: string, name: string) => {
      uploaded.push({ name, bytes: readFileSync(localPath).length });
    };

    for (let i = 0; i < 3; i += 1) {
      await runBackup(db, { dir: backups, keep: 2, intervalHours: 0 }, upload);
    }
    expect(listSnapshots(backups)).toHaveLength(2); // retention held
    expect(uploaded).toHaveLength(3); // every snapshot shipped
    expect(uploaded[0]!.bytes).toBeGreaterThan(0);
    db.close();
  });

  it("an upload failure does not fail the backup — a local snapshot still beats none", async () => {
    const dir = freshDir();
    const { db } = seededDb(dir);
    const backups = join(dir, "backups");
    const failing = async () => {
      throw new Error("blob unreachable");
    };
    const file = await runBackup(db, { dir: backups, keep: 3, intervalHours: 0 }, failing);
    expect(listSnapshots(backups).map((f) => f.name)).toEqual([file.name]);
    db.close();
  });
});

describe("startBackupSchedule", () => {
  it("is a no-op when the interval is 0 (e.g. :memory: databases)", () => {
    const dir = freshDir();
    const { db } = seededDb(dir);
    const stop = startBackupSchedule(db, { dir: join(dir, "backups"), keep: 3, intervalHours: 0 });
    stop();
    expect(listSnapshots(join(dir, "backups"))).toEqual([]);
    db.close();
  });

  it("runs on the configured interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const dir = freshDir();
    const { db } = seededDb(dir);
    const backups = join(dir, "backups");
    const stop = startBackupSchedule(db, { dir: backups, keep: 5, intervalHours: 1 });
    try {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 10);
      expect(listSnapshots(backups)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(listSnapshots(backups)).toHaveLength(2);
      stop();
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      expect(listSnapshots(backups)).toHaveLength(2); // stopped
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });
});
