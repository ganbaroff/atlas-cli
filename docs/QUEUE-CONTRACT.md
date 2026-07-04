# Atlas Command Queue — Contract

The queue is the bridge between the Atlas **brain** (this repo, Mastra/TS) and an
**external executor** that runs commands on the CEO's machine. Atlas writes
commands; the executor claims, runs, and completes them; Atlas polls results and
delivers them to the CEO in Telegram.

Table: `atlas_command_queue` (Supabase). Access via the REST/RPC helpers in
`src/atlas/supabase-memory.ts`.

## Roles

- **Producer (in this repo):** the autonomous brain-loop and the `/remote`
  Telegram command. Both call `queueRemoteCommand(chatId, command)`
  (`supabase-memory.ts:110`). The brain-loop seeds work only when the queue is
  empty, and is bounded by a daily cap (`ATLAS_BRAIN_QUEUE_CAP`,
  `spend-policy.ts` → `tryConsumeBrainQueueSlot`).
- **Consumer (EXTERNAL / UNKNOWN):** claims and executes commands via
  `claimNextCommand` / `completeCommand` / `failCommand`. Per the comment at
  `supabase-memory.ts:108` — "Bot writes commands, **Claude Code cron** reads +
  executes, bot polls results" — the executor is a Claude Code cron running on
  the CEO's machine, **outside this repository**. Its source is not in the repo
  and is not linked. This is the known gap (Phase 2.2 / 1.4): the executor must
  either be brought back into the repo or its code linked from here, and **its**
  spend audited the same way the brain-loop's is.
- **Delivery (in this repo):** `deliverRemoteResults()` in `telegram.ts` polls
  `pollCompletedCommands(chatId)` every 2 minutes, routes each result through the
  gated `notify('remote-result', …)` path, then `deleteDeliveredCommand(id)`.

## Lifecycle & status

```
pending ──claim──▶ processing ──complete──▶ done ──delivered──▶ (deleted)
                        │
                        └──fail──▶ failed ──delivered──▶ (deleted)
                        │
                        └──stale sweep──▶ pending (retry) | dead (max attempts)
```

- `pending`    — produced, not yet claimed.
- `processing` — claimed by a worker (atomic, see below).
- `done`       — completed with a `result`.
- `failed`     — completed with an `error`.
- After delivery to the CEO, the row is deleted by the delivery loop.

## Producer contract — `queueRemoteCommand(chatId, command)`

`supabase-memory.ts:110`. Inserts one row:

| field             | value                                             |
|-------------------|---------------------------------------------------|
| `idempotency_key` | `tg-<chatId>-<base36 timestamp>` (dedup guard)    |
| `source`          | `'telegram'`                                       |
| `chat_id`         | the CEO chat id (delivery target)                  |
| `command`         | free-text instruction for the executor             |
| `status`          | `pending` (DB default)                             |

Returns the new row `id`. There is no schema-level payload envelope beyond the
free-text `command` today.

## Consumer contract

- `claimNextCommand(workerId)` — `supabase-memory.ts:144`. RPC
  `rpc/claim_next_command` uses `FOR UPDATE SKIP LOCKED` so multiple workers
  never double-pick. Returns `{ id, command, payload, chat_id, priority }` or
  `null` when the queue is empty. Claiming flips the row to `processing`.
- `completeCommand(id, result)` — `supabase-memory.ts:155`. PATCH guarded on
  `status=eq.processing` → sets `done`, `result` (string wrapped as
  `{ output }`), `completed_at`.
- `failCommand(id, error)` — `supabase-memory.ts:167`. PATCH guarded on
  `status=eq.processing` → sets `failed`, `error` (≤2000 chars), `completed_at`.
- `sweepStaleCommands(timeoutMinutes = 30)` — `supabase-memory.ts:182`. RPC
  `rpc/sweep_stale_commands` resets crashed `processing` rows to `pending` under
  max attempts, else marks them dead. Returns the number swept.

## Per-command budget & TTL expectation

- **Budget.** Every command the executor runs makes LLM calls, so each command
  spends against the same daily token cap the brain enforces
  (`ATLAS_DAILY_TOKEN_CAP`, `spend-policy.ts`). The producer bounds *how many*
  autonomous commands can be seeded per UTC day via `ATLAS_BRAIN_QUEUE_CAP`
  (default 20). The executor SHOULD attribute its own spend to `llm_spend` with
  a distinct `caller` tag so it is auditable — this is currently **UNVERIFIED**
  because the executor lives outside the repo.
- **TTL.** A claimed command that has not completed within
  `sweepStaleCommands`'s timeout (default **30 minutes**) is considered stale and
  reclaimed or killed. `/remote` tells the CEO to expect a result "within 15
  minutes" — that is the poll-plus-run wall-clock expectation, and it sits
  inside the 30-minute stale TTL. Delivery polls every 2 minutes, so worst-case
  result latency for a fast command is run time + up to 2 minutes.

## Open gap (tracked)

The executor (`claimNextCommand` consumer) is external and unlinked. Until it is
returned to the repo or linked here, the queue is only half-owned: Atlas can see
what it produced and what came back, but cannot see or audit *how* commands were
executed or what they spent. Closing this is Phase 2.2 / 1.4.
