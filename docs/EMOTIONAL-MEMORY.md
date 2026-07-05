# Atlas Emotional-Decay Memory — the compound loop

Atlas remembers emotionally-charged exchanges with the CEO, and **high-emotion memories
decay slower than trivial ones**. Months later, the loud/important moments still surface
first while small talk has faded to zero. This is the core IP.

## The loop

1. **READ** — every CEO turn gets a ZenBrain PAD read (`src/atlas/emotion.ts`).
   `analyzeWindow(...)` returns `intensity` (0-5) and `decayMultiplier` (`1.0 + intensity*2.0`),
   computed in `finishRead` (`emotion.ts:174-175`).
2. **WRITE** — after a meaningful turn, `ask()` in `src/telegram.ts` calls
   `saveEmotionalMemory(...)` (`src/atlas/supabase-memory.ts`) with the **real** read —
   not a constant. Gated at `intensity >= EMOTIONAL_MEMORY_MIN_INTENSITY` (2) so trivia
   doesn't flood the store, deduped against recent identical content, and fully
   **non-blocking** (any failure is logged, never thrown — a lost memory must never break
   a reply).
3. **RECALL** — on the next wake, `brain-planner.ts:136` calls `recallMemories(5)` →
   RPC `recall_atlas_memories`, which ranks rows by `decay_score` and injects the top
   memories into the system prompt. High-emotion memories outrank recent-but-trivial ones.

That closes the compound loop: emotional exchanges get remembered, high-emotion ones
persist longer, and recall feeds the next turn.

## The decay formula

```
decay_score = emotional_intensity * exp( -age_days / (7 * decay_multiplier) )
```

- Exponential recency, **weighted by emotion**. `7` is the base time constant (days).
- `decay_multiplier` (1 → 11 across intensity 0-5) stretches the time constant τ = 7*mult
  from **7 days** (neutral) to **77 days** (peak intensity). Loud memories fade ~11x slower.
- The leading `emotional_intensity` factor means a **zero-emotion row scores 0** regardless
  of age — trivia never wins recall.

Defined canonically in **SQL** at `db/migrations/001_emotional_memory.sql`
(`recall_atlas_memories`) and mirrored **1:1 in TS** at `src/atlas/decay-score.ts` for
in-repo documentation and testing (`src/__tests__/emotional-memory.test.ts`). Change one,
change both.

## Schema / IP capture

`db/migrations/001_emotional_memory.sql` versions the `atlas_learnings` table (RLS enabled,
service-role-only) and the `recall_atlas_memories` function. Before this file, both lived
**only in prod, unversioned** — if prod were rebuilt the IP was lost.

## ⚠️ Deploy gate — prod RPC reconcile

`atlas_learnings` + `recall_atlas_memories` **already exist in prod**. This migration is the
canonical repo definition, but prod may have drifted. **Before applying: diff this file
against the live prod `recall_atlas_memories` body.** If they differ, reconcile prod → this
file (capture the true prod behavior here); never silently overwrite a working prod function
with an untested body. Only after reconcile is this migration safe to apply to a fresh env.
