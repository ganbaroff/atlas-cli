-- DEPRECATED: superseded by db/migrations/006_llm_spend.sql — use the numbered migration.
-- Atlas FinOps: per-call LLM spend telemetry.
-- Written by src/atlas/spend-tracker.ts via PostgREST (service role only).
--
-- Why: cerebras was tagged "free" but drained loaded funds because no code
-- knew prices or logged spend. This table is the audit trail — one row per
-- LLM call, cost estimated from a static price map at write time.

create table if not exists public.llm_spend (
  id            uuid primary key default gen_random_uuid(),
  ts            timestamptz not null default now(),
  provider      text not null,
  model         text not null,
  tokens_in     integer not null default 0,
  tokens_out    integer not null default 0,
  est_cost_usd  numeric(12, 6) not null default 0,
  caller        text not null default 'unknown'
);

-- Daily rollup queries hit ts constantly (briefing, heartbeat).
create index if not exists llm_spend_ts_idx on public.llm_spend (ts desc);

-- RLS: deny-all. Only the service role key (which bypasses RLS) may write.
-- No anon/authenticated policy exists → clients see nothing, write nothing.
alter table public.llm_spend enable row level security;
