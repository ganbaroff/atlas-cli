-- 000: Bootstrap Supabase-compatible roles for vanilla Postgres.
-- On Supabase these roles already exist; on a bare Postgres (local drill,
-- disaster recovery) they must be created so that RLS policies compile.
-- Idempotent: IF NOT EXISTS on every CREATE ROLE.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

-- Grant usage on public schema to all three roles (Supabase does this automatically).
grant usage on schema public to service_role, anon, authenticated;
