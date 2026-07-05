-- Atlas Emotional-Decay Memory — the canonical, versioned definition of the CEO's IP.
--
-- ⚠️  DEPLOY GATE: verify against the LIVE prod `recall_atlas_memories` before applying.
--     This function + table already exist in prod but were UNVERSIONED. This file is the
--     canonical repo definition; if prod has drifted, reconcile prod → this file (never
--     silently overwrite prod with an untested body). See docs/EMOTIONAL-MEMORY.md.
--
-- WHAT THIS IS: Atlas remembers emotionally-charged exchanges with the CEO, and
-- high-emotion memories decay SLOWER than trivial ones — so months later the loud,
-- important moments still surface first, while small talk fades. This is the compound
-- loop: emotional_intensity (0-5) and decay_multiplier (1.0 + intensity*2.0) are the
-- SAME numbers computed in src/atlas/emotion.ts:174-175 (ZenBrain PAD read), written
-- on meaningful turns and re-ranked on every recall.

-- ── Table ──────────────────────────────────────────────────────────────────────
-- emotional_intensity  : ZenBrain 0-5 (emotion.ts finishRead → Math.min(5, |v|*5 + a*2))
-- decay_multiplier     : 1.0 + intensity*2.0 (emotion.ts:175) — scales the half-life.
-- recall_count / last_recalled_at : recency-of-use bookkeeping (recall touches them).
create table if not exists public.atlas_learnings (
  id                  uuid primary key default gen_random_uuid(),
  category            text not null,
  content             text not null,
  emotional_intensity numeric(4, 2) not null default 0,
  decay_multiplier    numeric(4, 2) not null default 1.0,
  source_message      text,
  created_at          timestamptz not null default now(),
  last_recalled_at    timestamptz,
  recall_count        integer not null default 0
);

-- Recall ranks by recency*emotion, so created_at is the hot column.
create index if not exists atlas_learnings_created_at_idx
  on public.atlas_learnings (created_at desc);
create index if not exists atlas_learnings_category_idx
  on public.atlas_learnings (category);

-- ── RLS: service-role only ─────────────────────────────────────────────────────
-- Deny-all baseline: no anon/authenticated policy is granted, so only the service
-- role key (which BYPASSES RLS) may read or write. The bot uses the service role
-- key exclusively (supabase-memory.ts). An explicit restrictive policy makes the
-- intent auditable even though RLS-enabled-with-no-permissive-policy already denies.
alter table public.atlas_learnings enable row level security;

drop policy if exists atlas_learnings_service_role_only on public.atlas_learnings;
create policy atlas_learnings_service_role_only
  on public.atlas_learnings
  as permissive
  for all
  to service_role
  using (true)
  with check (true);

-- ── recall_atlas_memories(p_limit, p_category) ─────────────────────────────────
-- THE DECAY FORMULA (mirrored in TS at src/atlas/decay-score.ts):
--
--   decay_score = emotional_intensity * exp( -age_days / (7 * decay_multiplier) )
--
-- Emotion-weighted exponential recency. `7` is the BASE half-life-ish time constant
-- in days; multiplying by decay_multiplier (1 → 11 across intensity 0-5) stretches
-- the time constant so a loud memory (intensity 5 → mult 11 → τ = 77 days) keeps a
-- meaningful score long after a neutral one (intensity 0 → mult 1 → τ = 7 days) has
-- flattened to ~0. The leading emotional_intensity factor also means a zero-emotion
-- row scores 0 regardless of age — trivia never wins recall. High-emotion + recent
-- ranks strictly above low-emotion + old, which is the property tested in
-- src/__tests__/emotional-memory.test.ts.
create or replace function public.recall_atlas_memories(
  p_limit   integer default 10,
  p_category text   default null
)
returns table (
  id                  uuid,
  category            text,
  content             text,
  emotional_intensity numeric,
  decay_multiplier    numeric,
  created_at          timestamptz,
  decay_score         numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.category,
    l.content,
    l.emotional_intensity,
    l.decay_multiplier,
    l.created_at,
    (
      l.emotional_intensity
      * exp(
          - (extract(epoch from (now() - l.created_at)) / 86400.0)
          / (7.0 * greatest(l.decay_multiplier, 0.0001))
        )
    )::numeric as decay_score
  from public.atlas_learnings l
  where p_category is null or l.category = p_category
  order by decay_score desc
  limit greatest(p_limit, 1);
$$;
