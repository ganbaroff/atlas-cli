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
