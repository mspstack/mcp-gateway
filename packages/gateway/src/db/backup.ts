/**
 * Online backups of the gateway's SQLite database.
 *
 * The state here is not reproducible from config any more: upstream specs,
 * roles/grants/overrides, tool settings, users and group mappings, DCR clients,
 * refresh-token families, and the refs to every user's personal credentials.
 * Losing the file means reconfiguring by hand.
 *
 * Mechanics:
 *  - `VACUUM INTO` writes a consistent snapshot while the gateway keeps
 *    serving — unlike copying the file, which can capture a torn page mid-WAL.
 *  - Snapshots are pruned to the newest N locally.
 *  - Optionally shipped off-instance (a backup next to the database is not a
 *    backup): any uploader can be injected; Azure Blob is provided lazily so
 *    the SDK is only loaded when a container URL is configured.
 *
 * Restore is deliberately manual: stop the app, put the snapshot at DB_PATH
 * (drop any -wal/-shm siblings), start. Documented in docs/backups.md.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** File name prefix + shape: gateway-backup-2026-07-29T15-04-05-123Z.db */
const PREFIX = "gateway-backup-";
const SUFFIX = ".db";

export interface BackupConfig {
  /** Directory snapshots are written to. */
  dir: string;
  /** How many local snapshots to keep (oldest pruned first). */
  keep: number;
  /** 0 disables the scheduler; snapshots can still be taken on demand. */
  intervalHours: number;
  /** Container URL for off-instance copies, e.g. https://acct.blob.core.windows.net/gw-backups */
  blobContainerUrl?: string;
}

export interface BackupFile {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

/** Ships a finished snapshot somewhere durable. Injectable for tests. */
export type BackupUploader = (localPath: string, name: string) => Promise<void>;

const stamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

/**
 * Take a snapshot. `VACUUM INTO` refuses to overwrite, so the timestamped name
 * doubles as the uniqueness guarantee. Returns the file that was written.
 */
export function snapshot(db: DatabaseSync, dir: string, at: Date = new Date()): BackupFile {
  mkdirSync(dir, { recursive: true });
  const name = `${PREFIX}${stamp(at)}${SUFFIX}`;
  const path = join(dir, name);
  // SQLite has no parameter binding for VACUUM INTO; the path is ours (config
  // + generated name), and single quotes are escaped for good measure.
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  const stats = statSync(path);
  return { name, path, sizeBytes: stats.size, createdAt: at.toISOString() };
}

/** Newest first. Ignores anything that isn't one of our snapshots. */
export function listSnapshots(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
    .map((name) => {
      const path = join(dir, name);
      const stats = statSync(path);
      return { name, path, sizeBytes: stats.size, createdAt: stats.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Keep the newest `keep` snapshots; returns the names removed. */
export function pruneSnapshots(dir: string, keep: number): string[] {
  if (keep <= 0) return [];
  const removed: string[] = [];
  for (const file of listSnapshots(dir).slice(keep)) {
    try {
      unlinkSync(file.path);
      removed.push(file.name);
    } catch (err) {
      console.error(`[backup] could not prune ${file.name}: ${String(err)}`);
    }
  }
  return removed;
}

/**
 * Snapshot + prune (+ upload when configured). Upload failures are logged and
 * do NOT fail the backup: a local snapshot that exists beats none at all.
 */
export async function runBackup(
  db: DatabaseSync,
  config: BackupConfig,
  upload?: BackupUploader
): Promise<BackupFile> {
  const file = snapshot(db, config.dir);
  const pruned = pruneSnapshots(config.dir, config.keep);
  console.error(
    `[backup] wrote ${file.name} (${Math.round(file.sizeBytes / 1024)} KiB)` +
      (pruned.length ? `, pruned ${pruned.length}` : "")
  );
  if (upload) {
    try {
      await upload(file.path, file.name);
      console.error(`[backup] uploaded ${file.name} off-instance`);
    } catch (err) {
      console.error(`[backup] off-instance upload FAILED for ${file.name}: ${String(err)}`);
    }
  }
  return file;
}

/**
 * Azure Blob uploader using DefaultAzureCredential (same identity story as the
 * Key Vault store). Lazily imported so deployments without it pay nothing.
 */
export async function createBlobUploader(containerUrl: string): Promise<BackupUploader> {
  const [{ DefaultAzureCredential }, { ContainerClient }] = await Promise.all([
    import("@azure/identity"),
    import("@azure/storage-blob"),
  ]);
  const container = new ContainerClient(containerUrl, new DefaultAzureCredential());
  return async (localPath, name) => {
    await container.getBlockBlobClient(basename(name)).uploadFile(localPath);
  };
}

/**
 * Start the periodic backup loop. Returns a stop function; the timer is
 * unref'd so it never holds the process open on shutdown.
 */
export function startBackupSchedule(
  db: DatabaseSync,
  config: BackupConfig,
  upload?: BackupUploader
): () => void {
  if (config.intervalHours <= 0) return () => undefined;
  const everyMs = config.intervalHours * 60 * 60 * 1000;
  const tick = (): void => {
    runBackup(db, config, upload).catch((err) =>
      console.error(`[backup] scheduled backup failed: ${String(err)}`)
    );
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  console.error(
    `[backup] every ${config.intervalHours}h → ${config.dir} (keep ${config.keep})` +
      (config.blobContainerUrl ? " + off-instance copy" : " — LOCAL ONLY, no off-instance copy")
  );
  return () => clearInterval(timer);
}
