# Restore Drill Receipt

- **Script:** `scripts/restore-drill.mts` (node --import tsx)
- **Ran on:** 2026-07-28 ~09:32 UTC (run 1), ~09:33 UTC (run 2)
- **Machine:** Windows 11 Pro, Docker 29.5.2, postgres:15 container
- **Verdict:** PASS (both runs: 48/48, exit 0)

---

## Run 1 output

```
=== P1.3 RESTORE DRILL ===
Container: p1-restore-drill | Port: 55433 | DB: atlas_drill

[09:32:33] INFO: Setting up postgres:15 container "p1-restore-drill" on port 55433
[09:32:36] PASS: Container ready
[09:32:36] INFO: Applying migrations in MANIFEST order
[09:32:37] PASS: Migration 000 (000_roles_bootstrap.sql) applied
[09:32:38] PASS: Migration 001 (001_emotional_memory.sql) applied
[09:32:38] PASS: Migration 002 (002_learning_decisions.sql) applied
[09:32:39] PASS: Migration 003 (003_bot_sessions_messages.sql) applied
[09:32:40] PASS: Migration 004 (004_bot_heartbeats.sql) applied
[09:32:41] PASS: Migration 005 (005_command_queue.sql) applied
[09:32:42] PASS: Migration 006 (006_llm_spend.sql) applied
[09:32:42] PASS: Migration 007 (007_rls_learning_tables.sql) applied
[09:32:42] INFO: Asserting schema from MANIFEST
[09:32:43] PASS: Table atlas_learnings exists
[09:32:43] PASS: Table learning_decisions exists
[09:32:44] PASS: Table learning_outcomes exists
[09:32:44] PASS: Table bot_sessions exists
[09:32:44] PASS: Table bot_messages exists
[09:32:45] PASS: Table bot_heartbeats exists
[09:32:45] PASS: Table atlas_command_queue exists
[09:32:46] PASS: Table llm_spend exists
[09:32:46] PASS: RPC claim_next_command exists
[09:32:46] PASS: RPC sweep_stale_commands exists
[09:32:47] PASS: RPC recall_atlas_memories exists
[09:32:47] PASS: RPC bump_recall_count exists
[09:32:48] PASS: RLS enabled on atlas_learnings
[09:32:48] PASS: RLS enabled on learning_decisions
[09:32:49] PASS: RLS enabled on learning_outcomes
[09:32:49] PASS: RLS enabled on bot_sessions
[09:32:49] PASS: RLS enabled on bot_messages
[09:32:50] PASS: RLS enabled on bot_heartbeats
[09:32:50] PASS: RLS enabled on atlas_command_queue
[09:32:51] PASS: RLS enabled on llm_spend
[09:32:51] PASS: Index atlas_learnings_created_at_idx exists
[09:32:52] PASS: Index atlas_learnings_category_idx exists
[09:32:52] PASS: Index command_queue_claim_idx exists
[09:32:52] PASS: Index command_queue_chat_status_idx exists
[09:32:53] PASS: Index command_queue_stale_idx exists
[09:32:53] PASS: Index llm_spend_ts_idx exists
[09:32:54] PASS: Index llm_spend_correlation_idx exists
[09:32:54] INFO: Running agent-faithful smoke tests
[09:32:54] INFO: ── Queue round-trip ──
[09:32:54] PASS: Queue row inserted
[09:32:55] PASS: Queue row status = pending
[09:32:55] PASS: claim_next_command returned id: 9c01af35...
[09:32:55] PASS: Queue row status = processing after claim
[09:32:56] PASS: sweep_stale_commands returned: {"swept" : 1}
[09:32:57] PASS: Queue row reset to pending after sweep
[09:32:57] INFO: ── LLM spend write/read ──
[09:32:58] PASS: llm_spend row inserted
[09:32:58] PASS: llm_spend row read back correctly
[09:32:58] INFO: ── Learnings + recall ──
[09:32:59] PASS: atlas_learnings row inserted
[09:32:59] PASS: recall_atlas_memories returned the inserted row
[09:33:00] PASS: bump_recall_count incremented recall_count to 1
[09:33:01] INFO: Tearing down container
[09:33:02] PASS: Container removed

=== DRILL COMPLETE: 48 PASS, 0 FAIL ===
```

## Run 2 output (idempotency proof)

```
=== P1.3 RESTORE DRILL ===
Container: p1-restore-drill | Port: 55433 | DB: atlas_drill

[09:33:18] INFO: Setting up postgres:15 container "p1-restore-drill" on port 55433
[09:33:21] PASS: Container ready
[09:33:21] INFO: Applying migrations in MANIFEST order
[09:33:22] PASS: Migration 000 (000_roles_bootstrap.sql) applied
[09:33:23] PASS: Migration 001 (001_emotional_memory.sql) applied
[09:33:23] PASS: Migration 002 (002_learning_decisions.sql) applied
[09:33:24] PASS: Migration 003 (003_bot_sessions_messages.sql) applied
[09:33:25] PASS: Migration 004 (004_bot_heartbeats.sql) applied
[09:33:26] PASS: Migration 005 (005_command_queue.sql) applied
[09:33:27] PASS: Migration 006 (006_llm_spend.sql) applied
[09:33:27] PASS: Migration 007 (007_rls_learning_tables.sql) applied
[09:33:27] INFO: Asserting schema from MANIFEST
[09:33:28] PASS: Table atlas_learnings exists
[09:33:28] PASS: Table learning_decisions exists
[09:33:29] PASS: Table learning_outcomes exists
[09:33:29] PASS: Table bot_sessions exists
[09:33:30] PASS: Table bot_messages exists
[09:33:30] PASS: Table bot_heartbeats exists
[09:33:31] PASS: Table atlas_command_queue exists
[09:33:31] PASS: Table llm_spend exists
[09:33:31] PASS: RPC claim_next_command exists
[09:33:32] PASS: RPC sweep_stale_commands exists
[09:33:32] PASS: RPC recall_atlas_memories exists
[09:33:33] PASS: RPC bump_recall_count exists
[09:33:33] PASS: RLS enabled on atlas_learnings
[09:33:34] PASS: RLS enabled on learning_decisions
[09:33:34] PASS: RLS enabled on learning_outcomes
[09:33:35] PASS: RLS enabled on bot_sessions
[09:33:35] PASS: RLS enabled on bot_messages
[09:33:36] PASS: RLS enabled on bot_heartbeats
[09:33:36] PASS: RLS enabled on atlas_command_queue
[09:33:36] PASS: RLS enabled on llm_spend
[09:33:37] PASS: Index atlas_learnings_created_at_idx exists
[09:33:37] PASS: Index atlas_learnings_category_idx exists
[09:33:38] PASS: Index command_queue_claim_idx exists
[09:33:38] PASS: Index command_queue_chat_status_idx exists
[09:33:39] PASS: Index command_queue_stale_idx exists
[09:33:39] PASS: Index llm_spend_ts_idx exists
[09:33:39] PASS: Index llm_spend_correlation_idx exists
[09:33:39] INFO: Running agent-faithful smoke tests
[09:33:39] INFO: ── Queue round-trip ──
[09:33:40] PASS: Queue row inserted
[09:33:40] PASS: Queue row status = pending
[09:33:41] PASS: claim_next_command returned id: c091181d...
[09:33:41] PASS: Queue row status = processing after claim
[09:33:42] PASS: sweep_stale_commands returned: {"swept" : 1}
[09:33:42] PASS: Queue row reset to pending after sweep
[09:33:43] INFO: ── LLM spend write/read ──
[09:33:43] PASS: llm_spend row inserted
[09:33:44] PASS: llm_spend row read back correctly
[09:33:44] INFO: ── Learnings + recall ──
[09:33:45] PASS: atlas_learnings row inserted
[09:33:45] PASS: recall_atlas_memories returned the inserted row
[09:33:46] PASS: bump_recall_count incremented recall_count to 1
[09:33:47] INFO: Tearing down container
[09:33:47] PASS: Container removed

=== DRILL COMPLETE: 48 PASS, 0 FAIL ===
```

## Verification

- `npx tsc --noEmit`: clean (no errors)
- `npx vitest run`: 995 passed, 0 failed, 2 skipped (baseline unchanged)
- `docker ps -a --filter name=p1-restore-drill`: no container remains

---

## Wave C — Backup-Restore Proof (P1.2)

- **Script:** `scripts/restore-drill.mts --backup-restore`
- **Ran on:** 2026-07-28 ~12:06 UTC
- **Verdict:** PASS (78/78, exit 0)
- **Context:** DATABASE_URL was absent on this machine, so no live DB export was produced by
  `scripts/backup-atlas.mts`. Per the mission spec, the restore proof was run against a
  self-generated fixture: the drill built a scratch DB, inserted fixture data, exported CSVs,
  tore down, built a fresh scratch DB, imported the CSVs, then verified the restored data +
  full schema assertions.

### Backup job run (state-dirs only, DB SKIPPED)

```
=== ATLAS BACKUP JOB ===
Destination root: C:\Users\user\AtlasBackups
Retention: keep newest 14

[12:00:04] INFO: Backup dir: C:\Users\user\AtlasBackups\atlas-backup-2026-07-28T12-00-04-802
[12:00:04] OK: exec-graph: 3 files, 57.9 KB
[12:00:04] SKIP: goal-budgets: does not exist
[12:00:04] OK: evidence: 2 files, 16.8 KB
[12:00:04] OK: intake-drafts: 3 files, 4.0 KB
[12:00:04] OK: swarm-runs: 12 files, 7.9 KB
[12:00:04] OK: spend-receipts: 8 files, 107.5 KB
[12:00:04] SKIP: DATABASE_URL not set — DB export skipped
[12:00:04] OK: MANIFEST.json written
[12:00:04] INFO: Retention: 1 backups present, keep=14 — nothing to prune

=== BACKUP COMPLETE ===
WARNING: DB export was SKIPPED (DATABASE_URL not set). State dirs only.
```

### MANIFEST.json

```json
{
  "created": "2026-07-28T12:00:04.875Z",
  "machine": "WIN-QGHLRRNLBOF",
  "gitHead": "2d73e1a",
  "repoRoot": "C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS",
  "stateDirs": {
    "exec-graph": { "size": "57.9 KB", "files": 3 },
    "goal-budgets": { "size": "0 B", "files": 0 },
    "evidence": { "size": "16.8 KB", "files": 2 },
    "intake-drafts": { "size": "4.0 KB", "files": 3 },
    "swarm-runs": { "size": "7.9 KB", "files": 12 },
    "spend-receipts": { "size": "107.5 KB", "files": 8 }
  },
  "dbExport": "SKIPPED (DATABASE_URL not set)",
  "retentionKeep": 14
}
```

### Retention test

4 fake old `atlas-backup-*` dirs + 1 `unrelated-important-dir` created in a temp destination.
Ran with `--keep 2`. Result: 3 oldest pruned, 2 newest retained, `unrelated-important-dir` untouched.

### Backup-restore proof output

```
=== P1.2 BACKUP-RESTORE PROOF ===
Container: p1-restore-drill | Port: 55433 | DB: atlas_drill

[12:06:11] INFO: ── Phase 1: source DB + fixture data + export ──
[12:06:16] PASS: Container ready
[12:06:16] INFO: Applying migrations in MANIFEST order
[12:06:16] PASS: Migration 000 applied
[12:06:17] PASS: Migration 001 applied
[12:06:18] PASS: Migration 002 applied
[12:06:19] PASS: Migration 003 applied
[12:06:20] PASS: Migration 004 applied
[12:06:21] PASS: Migration 005 applied
[12:06:21] PASS: Migration 006 applied
[12:06:22] PASS: Migration 007 applied
[12:06:22] INFO: Running agent-faithful smoke tests
[12:06:23] PASS: Queue row inserted
[12:06:23] PASS: Queue row status = pending
[12:06:23] PASS: claim_next_command returned id
[12:06:24] PASS: Queue row status = processing after claim
[12:06:25] PASS: sweep_stale_commands returned: {"swept" : 1}
[12:06:25] PASS: Queue row reset to pending after sweep
[12:06:26] PASS: llm_spend row inserted
[12:06:26] PASS: llm_spend row read back correctly
[12:06:27] PASS: atlas_learnings row inserted
[12:06:28] PASS: recall_atlas_memories returned the inserted row
[12:06:29] PASS: bump_recall_count incremented recall_count to 1
[12:06:31] PASS: Fixture rows inserted into source DB
[12:06:31] INFO: Exporting fixture CSVs
[12:06:31] PASS: Exported atlas_learnings (2 rows)
[12:06:32] PASS: Exported learning_decisions (1 row header-only)
[12:06:32] PASS: Exported learning_outcomes (1 row header-only)
[12:06:33] PASS: Exported bot_sessions (1 row header-only)
[12:06:33] PASS: Exported bot_messages (1 row header-only)
[12:06:34] PASS: Exported bot_heartbeats (1 row header-only)
[12:06:34] PASS: Exported atlas_command_queue (2 rows)
[12:06:35] PASS: Exported llm_spend (2 rows)
[12:06:35] PASS: Container removed (phase 1 teardown)

[12:06:35] INFO: ── Phase 2: fresh DB + import + verify ──
[12:06:38] PASS: Container ready
[12:06:39-44] PASS: All 8 migrations applied
[12:06:44] INFO: Importing fixture CSVs
[12:06:45] PASS: Imported atlas_learnings
[12:06:45] PASS: learning_decisions: empty table, nothing to import
[12:06:45] PASS: learning_outcomes: empty table, nothing to import
[12:06:45] PASS: bot_sessions: empty table, nothing to import
[12:06:45] PASS: bot_messages: empty table, nothing to import
[12:06:45] PASS: bot_heartbeats: empty table, nothing to import
[12:06:45] PASS: Imported atlas_command_queue
[12:06:46] PASS: Imported llm_spend
[12:06:46] PASS: Restored atlas_learnings fixture verified
[12:06:47] PASS: Restored llm_spend fixture verified
[12:06:47] PASS: Restored atlas_command_queue fixture verified
[12:06:47] INFO: Asserting schema from MANIFEST
[12:06:48-57] PASS: All 8 tables, 4 RPCs, 8 RLS, 7 indexes verified
[12:07:00] PASS: Container removed (phase 2 teardown)

=== DRILL COMPLETE: 78 PASS, 0 FAIL ===
```
