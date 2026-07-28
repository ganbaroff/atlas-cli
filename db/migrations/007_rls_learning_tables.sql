-- 007: RLS catch-up for learning_decisions + learning_outcomes (002 omitted RLS).
-- Idempotent: enable is safe to re-run; guarded policy creation.

alter table public.learning_decisions enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'learning_decisions' and policyname = 'learning_decisions_service_role_only'
  ) then
    create policy learning_decisions_service_role_only
      on public.learning_decisions as permissive for all
      to service_role using (true) with check (true);
  end if;
end $$;

alter table public.learning_outcomes enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'learning_outcomes' and policyname = 'learning_outcomes_service_role_only'
  ) then
    create policy learning_outcomes_service_role_only
      on public.learning_outcomes as permissive for all
      to service_role using (true) with check (true);
  end if;
end $$;
