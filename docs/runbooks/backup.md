# Atlas Backup Runbook

## What it does

`scripts/backup-atlas.mts` produces a dated backup directory containing:
1. **State dirs** — copies of all local state directories (exec-graph, goal-budgets, evidence, intake-drafts, swarm-runs, spend-receipts/runner-state)
2. **DB export** — per-table CSV exports of all 8 Atlas tables (when `DATABASE_URL` is set)
3. **MANIFEST.json** — inventory with sizes, source machine, git HEAD

Backups land in `ATLAS_BACKUP_DIR` (default `~/AtlasBackups`) as `atlas-backup-<ISO-timestamp>/`.
Retention keeps the newest N and prunes only its own `atlas-backup-*` dirs — never touches anything else.

## Usage

```bash
# Default: ~/AtlasBackups, keep 14
node --import tsx scripts/backup-atlas.mts

# Custom destination and retention
node --import tsx scripts/backup-atlas.mts --dest /path/to/backups --keep 7

# With DB export (set DATABASE_URL first)
DATABASE_URL="postgresql://user:pass@host:5432/dbname" node --import tsx scripts/backup-atlas.mts
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ATLAS_BACKUP_DIR` | No | `~/AtlasBackups` | Root directory for backup archives |
| `ATLAS_BACKUP_KEEP` | No | `14` | Number of dated backups to retain |
| `DATABASE_URL` | No | _(none)_ | Postgres connection string for DB export; when absent, DB export is SKIPPED with a warning |
| `ATLAS_EXEC_GRAPH_DIR` | No | `state/exec-graph` | Override exec-graph state location |
| `ATLAS_GOAL_BUDGET_DIR` | No | `state/goal-budgets` | Override goal-budgets state location |
| `ATLAS_EVIDENCE_DIR` | No | `state/evidence` | Override evidence state location |
| `ATLAS_SPEND_RECEIPT_DIR` | No | `~/.atlas` | Override spend-receipts location |
| `ATLAS_STATE_DIR` | No | `~/.atlas` | Override runner lease/nonce state location |

## Scheduling (Windows Task Scheduler)

Register a daily task that runs at 03:00 AM:

```powershell
schtasks /Create /TN "AtlasBackup" /TR "node --import tsx C:\Users\user\OneDrive\Documents\GitHub\ANUS\scripts\backup-atlas.mts" /SC DAILY /ST 03:00 /F
```

> **UNTESTED** — this command was not dry-run (requires admin elevation). Verify after registration:
> ```powershell
> schtasks /Query /TN "AtlasBackup" /V
> ```
> To remove: `schtasks /Delete /TN "AtlasBackup" /F`

Set `DATABASE_URL` as an environment variable for the task's user account if DB export is desired.

## Restore from backup

### State dirs only

Copy the state dirs back to their expected locations:

```bash
# From a backup archive:
cp -r ~/AtlasBackups/atlas-backup-<timestamp>/state-dirs/exec-graph state/exec-graph
cp -r ~/AtlasBackups/atlas-backup-<timestamp>/state-dirs/goal-budgets state/goal-budgets
cp -r ~/AtlasBackups/atlas-backup-<timestamp>/state-dirs/evidence state/evidence
cp -r ~/AtlasBackups/atlas-backup-<timestamp>/state-dirs/intake-drafts state/intake-drafts
cp -r ~/AtlasBackups/atlas-backup-<timestamp>/state-dirs/swarm-runs state/swarm-runs
cp -r ~/AtlasBackups/atlas-backup-<timestamp>/state-dirs/spend-receipts ~/.atlas
```

### Database restore

1. Apply migrations to the target database (see `db/migrations/MANIFEST.md`):
   ```bash
   for f in db/migrations/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
   ```

2. Import the CSV exports:
   ```bash
   for csv in ~/AtlasBackups/atlas-backup-<timestamp>/db-export/*.csv; do
     table=$(basename "$csv" .csv)
     psql "$DATABASE_URL" -c "\COPY $table FROM '$csv' WITH (FORMAT csv, HEADER)"
   done
   ```

3. Verify with the restore drill:
   ```bash
   node --import tsx scripts/restore-drill.mts --backup-restore --export-dir ~/AtlasBackups/atlas-backup-<timestamp>/db-export
   ```

### Full restore proof

The backup-restore drill (`scripts/restore-drill.mts --backup-restore`) proves the end-to-end path:
builds a scratch DB, exports fixtures, rebuilds from scratch, imports, and verifies all data + schema.
See `docs/atlas-cto/RESTORE-DRILL-RECEIPT-2026-07-28.md` for the executed proof.

## Safety properties

- **Destination must be outside the repo** — the script refuses to run if the backup dir resolves inside the repo root.
- **Retention is scoped** — only dirs matching `atlas-backup-*` inside the destination are candidates for pruning. Unrelated files/dirs are never touched.
- **No symlink following** — symlinked state dirs or backup dirs are skipped.
- **Partial backup over none** — if DB export fails (env absent), state dirs are still archived. Exit 0 with a warning.
- **Exit 1 on state-dir failure** — if copying any state dir fails, exit code is non-zero.

## Open decisions

- **Off-machine destination**: backups are currently local-only. Moving them off-machine (cloud storage, NAS, another host) is a pending operator decision. Until decided, local backups protect against accidental file deletion but not machine loss.
