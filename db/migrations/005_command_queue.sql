-- 005: Atlas command queue table + RPCs (Telegram→runner bridge).
-- Referenced by: src/atlas/supabase-memory.ts (queueRemoteCommand, pollCompletedCommands,
--   deleteDeliveredCommand, peekQueue, claimNextCommand, completeCommand, failCommand,
--   sweepStaleCommands), src/atlas/atlas-runner.ts (consumer).
-- Idempotent: IF NOT EXISTS on table/indexes, CREATE OR REPLACE on functions, guarded policies.

-- ── atlas_command_queue ───────────────────────────────────────────────────
create table if not exists public.atlas_command_queue (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text unique,
  source          text not null default 'telegram',
  chat_id         bigint not null,
  command         text not null,
  payload         jsonb,
  status          text not null default 'pending',
  priority        integer not null default 0,
  attempts        integer not null default 0,
  max_attempts    integer not null default 3,
  worker_id       text,
  result          jsonb,
  error           text,
  created_at      timestamptz not null default now(),
  claimed_at      timestamptz,
  completed_at    timestamptz
);

-- Claim path: pending rows ordered by priority desc, created_at asc.
create index if not exists command_queue_claim_idx
  on public.atlas_command_queue (status, priority desc, created_at asc)
  where status = 'pending';

-- Poll path: chat_id + status for done/failed lookup.
create index if not exists command_queue_chat_status_idx
  on public.atlas_command_queue (chat_id, status, created_at desc);

-- Sweep stale: find processing rows by claimed_at.
create index if not exists command_queue_stale_idx
  on public.atlas_command_queue (claimed_at)
  where status = 'processing';

-- RLS: service-role only
alter table public.atlas_command_queue enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'atlas_command_queue' and policyname = 'command_queue_service_role_only'
  ) then
    create policy command_queue_service_role_only
      on public.atlas_command_queue as permissive for all
      to service_role using (true) with check (true);
  end if;
end $$;

-- ── claim_next_command(p_worker_id) ───────────────────────────────────────
-- Atomic claim: picks the highest-priority pending row, marks it processing.
-- FOR UPDATE SKIP LOCKED ensures concurrent consumers never double-pick.
-- Returns a single row (or nothing if queue empty).
create or replace function public.claim_next_command(p_worker_id text)
returns table (
  id        uuid,
  command   text,
  payload   jsonb,
  chat_id   bigint,
  priority  integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Lock one pending row
  select q.id into v_id
  from public.atlas_command_queue q
  where q.status = 'pending'
  order by q.priority desc, q.created_at asc
  limit 1
  for update skip locked;

  if v_id is null then
    return; -- empty queue
  end if;

  -- Transition to processing
  update public.atlas_command_queue q
  set status     = 'processing',
      worker_id  = p_worker_id,
      claimed_at = now(),
      attempts   = q.attempts + 1
  where q.id = v_id;

  -- Return the claimed row
  return query
    select q.id, q.command, q.payload, q.chat_id, q.priority
    from public.atlas_command_queue q
    where q.id = v_id;
end;
$$;

-- ── sweep_stale_commands(p_timeout_minutes) ───────────────────────────────
-- Resets stale processing commands (crashed consumer) to pending if under
-- max_attempts, otherwise marks them dead. Returns count swept.
create or replace function public.sweep_stale_commands(p_timeout_minutes integer default 30)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_swept integer := 0;
begin
  -- Re-queue rows under max_attempts
  with retryable as (
    update public.atlas_command_queue
    set status     = 'pending',
        worker_id  = null,
        claimed_at = null
    where status = 'processing'
      and claimed_at < now() - (p_timeout_minutes || ' minutes')::interval
      and attempts < max_attempts
    returning id
  )
  select count(*) into v_swept from retryable;

  -- Mark exhausted rows dead
  update public.atlas_command_queue
  set status       = 'dead',
      completed_at = now(),
      error        = 'max attempts exceeded (sweep)'
  where status = 'processing'
    and claimed_at < now() - (p_timeout_minutes || ' minutes')::interval
    and attempts >= max_attempts;

  v_swept := v_swept + found::integer;

  return json_build_object('swept', v_swept);
end;
$$;
