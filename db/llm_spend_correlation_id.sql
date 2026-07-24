-- Optional M6 additive column for llm_spend (CEO gate — do NOT apply without approval).
-- Base table: db/llm_spend.sql
-- Safe to apply after base table exists:
--   alter table public.llm_spend add column if not exists correlation_id text;

alter table public.llm_spend
  add column if not exists correlation_id text;

create index if not exists llm_spend_correlation_idx
  on public.llm_spend (correlation_id)
  where correlation_id is not null;
