/**
 * Copy .env vars to Railway project (names + values).
 * Run from ANUS dir: node scripts/setup-railway-env.mjs
 *
 * Security: values are passed as an argv array via spawnSync (shell: false),
 * never interpolated into a shell string. This prevents command injection and
 * keeps secret values out of the shell history / process-listing argv leak.
 * Pattern mirrors src/atlas/task-spawner.ts (spawn with argv, shell:false).
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const envFile = readFileSync('.env', 'utf-8');
const vars = [];
for (const line of envFile.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!val) continue;
  // Skip local paths that won't exist on Railway
  if (key === 'MEMORY_ROOT' || key === 'VOLAURA_ROOT' || key === 'OLLAMA_URL' || key === 'OLLAMA_HOST') continue;
  vars.push({ key, val });
}

console.log(`Setting ${vars.length} env vars on Railway...`);
for (const { key } of vars) {
  console.log(`  ${key}`);
}

/** Run `railway variables set ...` with an argv array — no shell, no interpolation. */
function railwaySet(pairs) {
  return spawnSync('railway', ['variables', 'set', ...pairs], {
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: 'inherit',
    shell: false,
  });
}

// Each "KEY=value" is one argv element, so a value containing spaces, quotes,
// or $() is passed literally — the shell never parses it.
const pairs = vars.map((v) => `${v.key}=${v.val}`);

const res = railwaySet(pairs);
if (res.status === 0) {
  console.log('Done!');
} else {
  console.error('Bulk set failed:', res.error?.message ?? `exit ${res.status}`);
  // Fallback: set one at a time so a single bad var doesn't block the rest.
  for (const { key, val } of vars) {
    const one = railwaySet([`${key}=${val}`]);
    console.log(`  ${one.status === 0 ? '✓' : '✗'} ${key}`);
  }
}
