# Migration Manifest

Apply order: 000 → 001 → 002 → 003 → 004 → 005 → 006 → 007

All migrations are idempotent (IF NOT EXISTS / CREATE OR REPLACE / guarded DO blocks).
Plain Postgres 15+; no Supabase-dashboard-only features.

## Migration files

| # | File | Objects created |
|---|------|-----------------|
| 000 | `000_roles_bootstrap.sql` | roles `service_role`, `anon`, `authenticated` (Supabase-compat bootstrap for vanilla PG) |
| 001 | `001_emotional_memory.sql` | table `atlas_learnings`, RPCs `recall_atlas_memories` + `bump_recall_count`, RLS |
| 002 | `002_learning_decisions.sql` | tables `learning_decisions` + `learning_outcomes` |
| 003 | `003_bot_sessions_messages.sql` | tables `bot_sessions` + `bot_messages`, RLS |
| 004 | `004_bot_heartbeats.sql` | table `bot_heartbeats`, RLS |
| 005 | `005_command_queue.sql` | table `atlas_command_queue`, RPCs `claim_next_command` + `sweep_stale_commands`, RLS |
| 006 | `006_llm_spend.sql` | table `llm_spend` (with `correlation_id`), RLS. Supersedes `db/llm_spend.sql` + `db/llm_spend_correlation_id.sql` |
| 007 | `007_rls_learning_tables.sql` | RLS catch-up for `learning_decisions` + `learning_outcomes` (002 omitted RLS) |

## Code reference → migration map

| Code reference | Table/RPC | Migration |
|----------------|-----------|-----------|
| `src/atlas/supabase-memory.ts:56` | `bot_sessions` (INSERT) | 003 |
| `src/atlas/supabase-memory.ts:69` | `bot_sessions` (PATCH) | 003 |
| `src/atlas/supabase-memory.ts:77` | `bot_sessions` (SELECT) | 003 |
| `src/atlas/supabase-memory.ts:91` | `bot_messages` (INSERT) | 003 |
| `src/atlas/supabase-memory.ts:105` | `bot_messages` (SELECT) | 003 |
| `src/atlas/supabase-memory.ts:363` | `bot_heartbeats` (INSERT) | 004 |
| `src/atlas/supabase-memory.ts:400` | `bot_heartbeats` (SELECT) | 004 |
| `src/research-swarm/memory-state.ts:21` | `bot_heartbeats` (health check) | 004 |
| `src/atlas/supabase-memory.ts:115` | `atlas_command_queue` (INSERT) | 005 |
| `src/atlas/supabase-memory.ts:133` | `atlas_command_queue` (SELECT poll) | 005 |
| `src/atlas/supabase-memory.ts:138` | `atlas_command_queue` (DELETE) | 005 |
| `src/atlas/supabase-memory.ts:150` | `atlas_command_queue` (SELECT peek) | 005 |
| `src/atlas/supabase-memory.ts:193` | `atlas_command_queue` (PATCH done) | 005 |
| `src/atlas/supabase-memory.ts:205` | `atlas_command_queue` (PATCH failed) | 005 |
| `src/atlas/supabase-memory.ts:171` | RPC `claim_next_command` | 005 |
| `src/atlas/supabase-memory.ts:220` | RPC `sweep_stale_commands` | 005 |
| `src/atlas/supabase-memory.ts:234` | RPC `recall_atlas_memories` | 001 |
| `src/atlas/supabase-memory.ts:250` | RPC `bump_recall_count` | 001 |
| `src/atlas/supabase-memory.ts:272` | `atlas_learnings` (INSERT) | 001 |
| `src/atlas/supabase-memory.ts:382` | `atlas_learnings` (SELECT journal) | 001 |
| `src/atlas/spend-tracker.ts:161` | `llm_spend` (INSERT) | 006 |

## bot_sessions / bot_messages verdict

**CONFIRMED in code.** Both tables are actively referenced in `src/atlas/supabase-memory.ts`
(lines 56, 69, 77 for sessions; lines 91, 105 for messages). They are real runtime dependencies,
not stale deploy-note artifacts. Migration 003 defines them.
