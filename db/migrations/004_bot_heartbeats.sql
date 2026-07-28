-- 004: Bot heartbeat table (operational liveness).
-- Referenced by: src/atlas/supabase-memory.ts (writeHeartbeatDB, loadLatestHeartbeatDB),
--   src/research-swarm/memory-state.ts (health check).
-- Idempotent: IF NOT EXISTS on table/index, guarded policy creation.

create table if not exists public.bot_heartbeats (
  id              uuid primary key default gen_random_uuid(),
  providers       integer not null default 0,
  uptime_minutes  integer not null default 0,
  message_count   integer not null default 0,
  chat_count      integer not null default 0,
  created_at      timestamptz not null default now()
);

-- Heartbeat lookup is always "latest first".
create index if not exists bot_heartbeats_created_at_idx
  on public.bot_heartbeats (created_at desc);

-- RLS: service-role only
alter table public.bot_heartbeats enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'bot_heartbeats' and policyname = 'bot_heartbeats_service_role_only'
  ) then
    create policy bot_heartbeats_service_role_only
      on public.bot_heartbeats as permissive for all
      to service_role using (true) with check (true);
  end if;
end $$;
