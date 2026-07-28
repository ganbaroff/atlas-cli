-- 003: Bot session & message tables (conversation store).
-- Referenced by: src/atlas/supabase-memory.ts (createSession, updateSession,
--   getLatestSession, saveMessage, loadMessages).
-- Idempotent: IF NOT EXISTS on tables/indexes, guarded policy creation.

-- ── bot_sessions ──────────────────────────────────────────────────────────
create table if not exists public.bot_sessions (
  id               uuid primary key default gen_random_uuid(),
  chat_id          bigint not null,
  message_count    integer not null default 0,
  emotional_state  jsonb,
  provider_used    text,
  summary          text,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists bot_sessions_chat_id_idx
  on public.bot_sessions (chat_id, created_at desc);

-- RLS: service-role only (bot uses service_role key exclusively)
alter table public.bot_sessions enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'bot_sessions' and policyname = 'bot_sessions_service_role_only'
  ) then
    create policy bot_sessions_service_role_only
      on public.bot_sessions as permissive for all
      to service_role using (true) with check (true);
  end if;
end $$;

-- ── bot_messages ──────────────────────────────────────────────────────────
create table if not exists public.bot_messages (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.bot_sessions (id),
  chat_id         bigint not null,
  role            text not null,
  content         text not null,
  provider        text,
  model           text,
  emotional_read  jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists bot_messages_chat_id_idx
  on public.bot_messages (chat_id, created_at desc);

create index if not exists bot_messages_session_id_idx
  on public.bot_messages (session_id);

-- RLS: service-role only
alter table public.bot_messages enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'bot_messages' and policyname = 'bot_messages_service_role_only'
  ) then
    create policy bot_messages_service_role_only
      on public.bot_messages as permissive for all
      to service_role using (true) with check (true);
  end if;
end $$;
