# Backups and restore

The gateway's SQLite database is not reproducible from configuration. It holds
upstream specs, roles, grants and per-tool settings, users and group mappings,
dynamically registered OAuth clients, refresh-token families, and the
references to every user's personal credentials. Losing it means rebuilding all
of that by hand — so back it up.

## What runs by default

On every boot the gateway starts a periodic snapshot loop:

| Env | Default | Meaning |
| --- | --- | --- |
| `BACKUP_INTERVAL_HOURS` | `24` | snapshot cadence; `0` disables the loop (on-demand still works) |
| `BACKUP_DIR` | `<dir of DB_PATH>/backups` | where snapshots land |
| `BACKUP_KEEP` | `7` | how many local snapshots to keep — oldest pruned first |
| `BACKUP_BLOB_CONTAINER_URL` | — | Azure Blob container for off-instance copies (`DefaultAzureCredential`) |

Snapshots are taken with SQLite's `VACUUM INTO`, which writes a consistent
copy while the gateway keeps serving. Copying `gateway.db` with `cp` while the
process runs is **not** a backup — it can capture a torn page mid-WAL.

Files are named `gateway-backup-<ISO timestamp>.db`, so they sort
chronologically and never overwrite each other.

An in-memory database (`DB_PATH=:memory:`) has nothing durable to snapshot, so
the loop stays off there regardless of the interval.

## Off-instance copies

A backup living next to the database is not a backup: the App Service instance
that loses the disk loses both. Set `BACKUP_BLOB_CONTAINER_URL` to a container
URL and each snapshot is uploaded with the gateway's managed identity (needs
**Storage Blob Data Contributor** on the container). Upload failures are logged
loudly but never fail the snapshot itself — a local copy still beats none.

## On demand

Admin API (admin role required):

```bash
curl -s -X POST https://<gateway>/api/backups -H "Authorization: Bearer <admin token>"
```

```bash
curl -s https://<gateway>/api/backups -H "Authorization: Bearer <admin token>"
```

`GET` returns the configured directory, retention, interval, whether an
off-instance target is set, and the snapshots currently on disk.

## Restore

Deliberately manual — restoring is rare and destructive, so it is not a button.

1. Stop the gateway (App Service: stop the app, or `docker compose stop`).
2. Put the snapshot where `DB_PATH` points, e.g. `data/gateway.db`.
3. Delete any `gateway.db-wal` / `gateway.db-shm` siblings — they belong to the
   old database and will confuse SQLite about the restored one.
4. Start the gateway. Schema migrations are idempotent and run on boot, so a
   snapshot from an older version upgrades itself.
5. Verify: `GET /api/status` (upstream count and tool count) and `GET /api/roles`
   (grants matrix). Personal credentials keep working because the database
   stores only references — the values live in the secret store, untouched by
   the restore.

Test the restore path on a scratch instance before you need it; an untested
backup is a hope, not a plan.
