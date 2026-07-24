/**
 * One-shot: apply llm_spend DDL via Supabase Management API + smoke insert probe.
 * Reads SUPABASE_ACCESS_TOKEN from VOLAURA apps/api/.env (Atlas lane uses shared Supabase project).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'dwdgzfusjsobnixgyzjk';

function loadVolauraToken(): string {
  const envPath = 'C:/Projects/VOLAURA/apps/api/.env';
  const raw = readFileSync(envPath, 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  if (!line) throw new Error('SUPABASE_ACCESS_TOKEN not found in VOLAURA apps/api/.env');
  return line.split('=').slice(1).join('=').trim();
}

async function runSql(token: string, query: string, label: string): Promise<void> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${label} failed ${res.status}: ${body.slice(0, 300)}`);
  console.log(JSON.stringify({ step: label, ok: true }));
}

async function main() {
  const token = loadVolauraToken();
  const sql1 = readFileSync(join(ROOT, 'db/llm_spend.sql'), 'utf8');
  const sql2 = readFileSync(join(ROOT, 'db/llm_spend_correlation_id.sql'), 'utf8');
  await runSql(token, sql1, 'llm_spend_base');
  await runSql(token, sql2, 'llm_spend_correlation_id');

  // Smoke via ANUS spend-tracker (loads .env from ANUS root)
  await import('dotenv/config');
  const { recordSpend } = await import('../src/atlas/spend-tracker.ts');
  const cid = `corr_smoke_${Date.now()}`;
  recordSpend({
    provider: 'ollama',
    model: 'smoke-test',
    tokensIn: 1,
    tokensOut: 1,
    caller: 'smoke',
    correlationId: cid,
  });
  await new Promise((r) => setTimeout(r, 2000));

  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const probe = await fetch(
    `${url}/rest/v1/llm_spend?correlation_id=eq.${cid}&select=id,correlation_id,provider`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  const rows = await probe.json();
  console.log(JSON.stringify({ step: 'live_smoke', correlationId: cid, rows, probeStatus: probe.status }));
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
