import { readFileSync } from 'node:fs';

const raw = readFileSync('C:/Projects/VOLAURA/apps/api/.env', 'utf8');
const token = raw.match(/SUPABASE_ACCESS_TOKEN=(.+)/)?.[1]?.trim()!;
const PROJECT = 'dwdgzfusjsobnixgyzjk';

async function sql(query: string) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: r.status, body: await r.text() };
}

const cols = await sql(`select column_name from information_schema.columns where table_schema='public' and table_name='llm_spend' order by ordinal_position`);
console.log('columns:', cols.body);

const reload = await sql(`NOTIFY pgrst, 'reload schema'`);
console.log('reload:', reload.status);

const addCol = await sql(`alter table public.llm_spend add column if not exists correlation_id text`);
console.log('addCol:', addCol.status, addCol.body.slice(0, 200));

const reload2 = await sql(`NOTIFY pgrst, 'reload schema'`);
console.log('reload2:', reload2.status);
