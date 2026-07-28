-- 006: LLM spend telemetry table (supersedes db/llm_spend.sql + db/llm_spend_correlation_id.sql).
-- Referenced by: src/atlas/spend-tracker.ts (writeSpendRow).
-- Idempotent: IF NOT EXISTS on table/indexes, guarded policy creation.
-- Includes the correlation_id column from the start (the stray additive migration is merged here).

create table if not exists public.llm_spend (
  id              uuid primary key default gen_random_uuid(),
  ts              timestamptz not null default now(),
  provider        text not null,
  model           text not null,
  tokens_in       integer not null default 0,
  tokens_out      integer not null default 0,
  est_cost_usd    numeric(12, 6) not null default 0,
  caller          text not null default 'unknown',
  correlation_id  text
);

-- Daily rollup queries hit ts constantly (briefing, heartbeat).
create index if not exists llm_spend_ts_idx
  on public.llm_spend (ts desc);

-- Correlation lookup (partial — only non-null rows indexed).
create index if not exists llm_spend_correlation_idx
  on public.llm_spend (correlation_id)
  where correlation_id is not null;

-- RLS: service-role only (deny-all for anon/authenticated).
alter table public.llm_spend enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'llm_spend' and policyname = 'llm_spend_service_role_only'
  ) then
    create policy llm_spend_service_role_only
      on public.llm_spend as permissive for all
      to service_role using (true) with check (true);
  end if;
end $$;
