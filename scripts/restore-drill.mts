/**
 * P1.3 Restore Drill — proves the database can be rebuilt from migrations alone.
 *
 * Usage: node --import tsx scripts/restore-drill.mts
 *
 * Steps:
 *   1. Stand up disposable postgres:15 container (p1-restore-drill)
 *   2. Apply ALL migrations in MANIFEST order
 *   3. Assert schema: tables, RPCs, RLS, indexes
 *   4. Agent-faithful smoke tests (queue round-trip, spend, learnings)
 *   5. Tear down container
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CONTAINER = 'p1-restore-drill';
const PORT = process.env['ATLAS_DRILL_PORT'] ?? '55433';
const DB_USER = 'postgres';
const DB_PASS = 'drill_throwaway_2026';
const DB_NAME = 'atlas_drill';

const MIGRATIONS_DIR = join(import.meta.dirname!, '..', 'db', 'migrations');
const MANIFEST_ORDER = ['000', '001', '002', '003', '004', '005', '006', '007'];

let failures = 0;
let passes = 0;

function log(status: 'PASS' | 'FAIL' | 'INFO', msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${status}: ${msg}`);
  if (status === 'FAIL') failures++;
  if (status === 'PASS') passes++;
}

function run(cmd: string, opts?: { ignoreError?: boolean }): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 60_000 }).trim();
  } catch (e: any) {
    if (opts?.ignoreError) return e.stdout?.toString()?.trim() ?? '';
    throw e;
  }
}

function psql(sql: string): string {
  // Pipe SQL via stdin to avoid shell quoting issues with single quotes
  try {
    return execSync(
      `docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A`,
      { encoding: 'utf-8', input: sql, timeout: 60_000 }
    ).trim();
  } catch (e: any) {
    throw new Error(`psql failed: ${(e.stderr ?? e.message ?? '').toString().slice(0, 300)}`);
  }
}

// ── Step 1: Stand up container ──────────────────────────────────────────

function setupContainer(): void {
  log('INFO', `Setting up postgres:15 container "${CONTAINER}" on port ${PORT}`);

  // Remove existing container if any (idempotent)
  run(`docker rm -f ${CONTAINER}`, { ignoreError: true });

  run(
    `docker run -d --name ${CONTAINER} ` +
    `-e POSTGRES_PASSWORD=${DB_PASS} ` +
    `-e POSTGRES_DB=${DB_NAME} ` +
    `-p ${PORT}:5432 ` +
    `postgres:15`
  );

  // Wait for postgres to be ready (up to 30s)
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      run(`docker exec ${CONTAINER} pg_isready -U ${DB_USER}`);
      ready = true;
      break;
    } catch {
      run('sleep 1');
    }
  }
  if (!ready) {
    log('FAIL', 'Postgres container did not become ready within 30s');
    throw new Error('Container startup timeout');
  }
  log('PASS', 'Container ready');
}

// ── Step 2: Apply migrations ────────────────────────────────────────────

function applyMigrations(): void {
  log('INFO', 'Applying migrations in MANIFEST order');

  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

  for (const num of MANIFEST_ORDER) {
    const file = files.find(f => f.startsWith(`${num}_`));
    if (!file) {
      log('FAIL', `Migration file for ${num} not found`);
      throw new Error(`Missing migration ${num}`);
    }

    const sqlPath = join(MIGRATIONS_DIR, file).replace(/\\/g, '/');
    const sql = readFileSync(sqlPath, 'utf-8');

    // Copy SQL into container and run it
    run(`docker cp "${sqlPath}" ${CONTAINER}:/tmp/${file}`);
    try {
      run(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1 -f /tmp/${file}`);
      log('PASS', `Migration ${num} (${file}) applied`);
    } catch (e: any) {
      log('FAIL', `Migration ${num} (${file}) failed: ${e.message?.slice(0, 200)}`);
      throw e;
    }
  }
}

// ── Step 3: Schema assertions ───────────────────────────────────────────

function assertSchema(): void {
  log('INFO', 'Asserting schema from MANIFEST');

  // Tables expected
  const tables = [
    'atlas_learnings', 'learning_decisions', 'learning_outcomes',
    'bot_sessions', 'bot_messages', 'bot_heartbeats',
    'atlas_command_queue', 'llm_spend',
  ];

  for (const t of tables) {
    const exists = psql(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}')`
    );
    if (exists === 't') {
      log('PASS', `Table ${t} exists`);
    } else {
      log('FAIL', `Table ${t} MISSING`);
    }
  }

  // RPC functions expected
  const rpcs = [
    'claim_next_command', 'sweep_stale_commands',
    'recall_atlas_memories', 'bump_recall_count',
  ];

  for (const fn of rpcs) {
    const exists = psql(
      `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='${fn}')`
    );
    if (exists === 't') {
      log('PASS', `RPC ${fn} exists`);
    } else {
      log('FAIL', `RPC ${fn} MISSING`);
    }
  }

  // RLS enabled on every table
  for (const t of tables) {
    const rls = psql(
      `SELECT relrowsecurity FROM pg_class WHERE relname='${t}'`
    );
    if (rls === 't') {
      log('PASS', `RLS enabled on ${t}`);
    } else {
      log('FAIL', `RLS NOT enabled on ${t}`);
    }
  }

  // Key indexes
  const indexes = [
    'atlas_learnings_created_at_idx',
    'atlas_learnings_category_idx',
    'command_queue_claim_idx',
    'command_queue_chat_status_idx',
    'command_queue_stale_idx',
    'llm_spend_ts_idx',
    'llm_spend_correlation_idx',
  ];

  for (const idx of indexes) {
    const exists = psql(
      `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='${idx}')`
    );
    if (exists === 't') {
      log('PASS', `Index ${idx} exists`);
    } else {
      log('FAIL', `Index ${idx} MISSING`);
    }
  }
}

// ── Step 4: Smoke tests ─────────────────────────────────────────────────

function smokeTests(): void {
  log('INFO', 'Running agent-faithful smoke tests');

  // Smoke tests run as postgres superuser which bypasses RLS. Schema assertions
  // above already proved RLS is enabled on every table. The RPCs are SECURITY DEFINER
  // running as the function owner (postgres) — same as Supabase's service_role bypass.

  // 4a: Queue round-trip (mirrors queueRemoteCommand → claim_next_command → sweep)
  log('INFO', '── Queue round-trip ──');

  // Insert a queue row (mirrors supabase-memory.ts:115 queueRemoteCommand shape)
  psql(`INSERT INTO atlas_command_queue (idempotency_key, source, chat_id, command, payload) VALUES ('drill-key-1', 'telegram', 12345, '/drill test', '{"test":true}'::jsonb)`);
  log('PASS', 'Queue row inserted');

  // Verify it's pending
  const pendingStatus = psql(`SELECT status FROM atlas_command_queue WHERE idempotency_key='drill-key-1'`);
  if (pendingStatus === 'pending') {
    log('PASS', 'Queue row status = pending');
  } else {
    log('FAIL', `Queue row status expected 'pending', got '${pendingStatus}'`);
  }

  // Claim via RPC (mirrors supabase-memory.ts:171 claimNextCommand)
  const claimedId = psql(`SELECT id FROM claim_next_command('drill-worker-1')`);
  if (claimedId) {
    log('PASS', `claim_next_command returned id: ${claimedId.slice(0, 8)}...`);
  } else {
    log('FAIL', 'claim_next_command returned no row');
  }

  // Verify claimed state
  const claimedStatus = psql(`SELECT status FROM atlas_command_queue WHERE idempotency_key='drill-key-1'`);
  if (claimedStatus === 'processing') {
    log('PASS', 'Queue row status = processing after claim');
  } else {
    log('FAIL', `Queue row status expected 'processing', got '${claimedStatus}'`);
  }

  // Sweep (mirrors supabase-memory.ts:220 sweepStaleCommands)
  // First backdate the claimed_at to trigger sweep
  psql(`UPDATE atlas_command_queue SET claimed_at = now() - interval '60 minutes' WHERE idempotency_key='drill-key-1'`);
  const sweepResult = psql(`SELECT * FROM sweep_stale_commands(30)`);
  log('PASS', `sweep_stale_commands returned: ${sweepResult}`);

  // Verify sweep effect (row should be back to pending since attempts=1 < max_attempts=3)
  const postSweepStatus = psql(`SELECT status FROM atlas_command_queue WHERE idempotency_key='drill-key-1'`);
  if (postSweepStatus === 'pending') {
    log('PASS', 'Queue row reset to pending after sweep');
  } else {
    log('FAIL', `Queue row expected 'pending' after sweep, got '${postSweepStatus}'`);
  }

  // Cleanup queue test data
  psql(`DELETE FROM atlas_command_queue WHERE idempotency_key='drill-key-1'`);

  // 4b: llm_spend insert + read (mirrors spend-tracker.ts:142 writeSpendRow shape)
  log('INFO', '── LLM spend write/read ──');

  psql(`INSERT INTO llm_spend (provider, model, tokens_in, tokens_out, est_cost_usd, caller, correlation_id) VALUES ('nvidia', 'meta/llama-3.1-70b', 500, 200, 0.001, 'drill-test', 'drill-corr-1')`);
  log('PASS', 'llm_spend row inserted');

  const spendRead = psql(`SELECT provider, model, tokens_in FROM llm_spend WHERE correlation_id='drill-corr-1'`);
  if (spendRead.includes('nvidia') && spendRead.includes('500')) {
    log('PASS', 'llm_spend row read back correctly');
  } else {
    log('FAIL', `llm_spend read unexpected: ${spendRead}`);
  }

  // Cleanup
  psql(`DELETE FROM llm_spend WHERE correlation_id='drill-corr-1'`);

  // 4c: atlas_learnings + recall RPCs (mirrors supabase-memory.ts:272 saveMemory + :234 recallMemories)
  log('INFO', '── Learnings + recall ──');

  psql(`INSERT INTO atlas_learnings (category, content, emotional_intensity, decay_multiplier, source_message) VALUES ('drill_test', 'drill memory content', 3.5, 8.0, 'drill source')`);
  log('PASS', 'atlas_learnings row inserted');

  // recall_atlas_memories RPC (mirrors supabase-memory.ts:234)
  const recallResult = psql(`SELECT category, content FROM recall_atlas_memories(10, 'drill_test')`);
  if (recallResult.includes('drill memory content')) {
    log('PASS', 'recall_atlas_memories returned the inserted row');
  } else {
    log('FAIL', `recall_atlas_memories unexpected: ${recallResult}`);
  }

  // bump_recall_count (mirrors supabase-memory.ts:250)
  const learnId = psql(`SELECT id FROM atlas_learnings WHERE category='drill_test' LIMIT 1`);
  psql(`SELECT bump_recall_count(ARRAY['${learnId}']::uuid[])`);
  const recallCount = psql(`SELECT recall_count FROM atlas_learnings WHERE id='${learnId}'`);
  if (recallCount === '1') {
    log('PASS', 'bump_recall_count incremented recall_count to 1');
  } else {
    log('FAIL', `bump_recall_count expected recall_count=1, got '${recallCount}'`);
  }

  // Cleanup
  psql(`DELETE FROM atlas_learnings WHERE category='drill_test'`);
}

// ── Step 5: Tear down ───────────────────────────────────────────────────

function teardown(): void {
  log('INFO', 'Tearing down container');
  run(`docker rm -f ${CONTAINER}`, { ignoreError: true });
  log('PASS', 'Container removed');
}

// ── Backup-restore proof ───────────────────────────────────────────────

const BACKUP_RESTORE = process.argv.includes('--backup-restore');
const BACKUP_EXPORT_DIR = (() => {
  const idx = process.argv.indexOf('--export-dir');
  return idx >= 0 ? process.argv[idx + 1] : undefined;
})();

const MANIFEST_TABLES = [
  'atlas_learnings', 'learning_decisions', 'learning_outcomes',
  'bot_sessions', 'bot_messages', 'bot_heartbeats',
  'atlas_command_queue', 'llm_spend',
];

/**
 * Export all tables from the current scratch DB as CSV (simulates backup DB export).
 * If --export-dir is given, uses that dir; otherwise creates a temp dir.
 */
function exportFixtures(): string {
  const exportDir = BACKUP_EXPORT_DIR ?? join(tmpdir(), `atlas-drill-fixtures-${Date.now()}`);
  mkdirSync(exportDir, { recursive: true });
  log('INFO', `Exporting fixture CSVs to ${exportDir}`);

  for (const table of MANIFEST_TABLES) {
    try {
      const csv = execSync(
        `docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c "\\COPY ${table} TO STDOUT WITH (FORMAT csv, HEADER)"`,
        { encoding: 'utf-8', timeout: 30_000 },
      );
      const outPath = join(exportDir, `${table}.csv`);
      writeFileSync(outPath, csv, 'utf-8');
      log('PASS', `Exported ${table} (${csv.split('\n').length - 1} rows incl header)`);
    } catch (e: any) {
      log('FAIL', `Export ${table} failed: ${e.message?.slice(0, 200)}`);
    }
  }

  return exportDir;
}

/**
 * Import CSV fixtures into the current scratch DB (simulates restore from backup).
 */
function importFixtures(exportDir: string): void {
  log('INFO', `Importing fixture CSVs from ${exportDir}`);

  for (const table of MANIFEST_TABLES) {
    const csvPath = join(exportDir, `${table}.csv`);
    if (!existsSync(csvPath)) {
      log('SKIP', `No CSV for ${table}`);
      continue;
    }

    const csvContent = readFileSync(csvPath, 'utf-8');
    // Skip if only header (empty table)
    if (csvContent.trim().split('\n').length <= 1) {
      log('PASS', `${table}: empty table, nothing to import`);
      continue;
    }

    try {
      // Pipe CSV via stdin to COPY FROM
      execSync(
        `docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c "\\COPY ${table} FROM STDIN WITH (FORMAT csv, HEADER)"`,
        { encoding: 'utf-8', input: csvContent, timeout: 30_000 },
      );
      log('PASS', `Imported ${table}`);
    } catch (e: any) {
      log('FAIL', `Import ${table} failed: ${e.message?.slice(0, 200)}`);
    }
  }
}

/**
 * Backup-restore proof path:
 * 1. Stand up container A, apply migrations, insert fixture data, export CSVs
 * 2. Tear down A
 * 3. Stand up container B, apply migrations, import CSVs, run assertions + smoke
 * 4. Tear down B
 */
function backupRestoreProof(): void {
  console.log('=== P1.2 BACKUP-RESTORE PROOF ===');
  console.log(`Container: ${CONTAINER} | Port: ${PORT} | DB: ${DB_NAME}`);
  console.log('');

  let exportDir: string;

  // Phase 1: build source DB with fixture data, then export
  log('INFO', '── Phase 1: source DB + fixture data + export ──');
  try {
    setupContainer();
    applyMigrations();
    smokeTests(); // inserts + cleans up, but we need data for export...
    // Insert durable fixture rows for export
    psql(`INSERT INTO atlas_learnings (category, content, emotional_intensity, decay_multiplier, source_message) VALUES ('backup_test', 'backup fixture content', 2.5, 5.0, 'backup source')`);
    psql(`INSERT INTO llm_spend (provider, model, tokens_in, tokens_out, est_cost_usd, caller, correlation_id) VALUES ('test-provider', 'test-model', 100, 50, 0.0001, 'backup-drill', 'backup-corr-1')`);
    psql(`INSERT INTO atlas_command_queue (idempotency_key, source, chat_id, command, payload) VALUES ('backup-key-1', 'telegram', 99999, '/backup test', '{"backup":true}'::jsonb)`);
    log('PASS', 'Fixture rows inserted into source DB');
    exportDir = exportFixtures();
  } finally {
    teardown();
  }

  // Phase 2: fresh DB, apply migrations, import CSVs, verify
  log('INFO', '── Phase 2: fresh DB + import + verify ──');
  try {
    setupContainer();
    applyMigrations();
    importFixtures(exportDir);

    // Verify imported data
    const learningRow = psql(`SELECT content FROM atlas_learnings WHERE category='backup_test'`);
    if (learningRow.includes('backup fixture content')) {
      log('PASS', 'Restored atlas_learnings fixture verified');
    } else {
      log('FAIL', `atlas_learnings fixture not found: ${learningRow}`);
    }

    const spendRow = psql(`SELECT provider FROM llm_spend WHERE correlation_id='backup-corr-1'`);
    if (spendRow.includes('test-provider')) {
      log('PASS', 'Restored llm_spend fixture verified');
    } else {
      log('FAIL', `llm_spend fixture not found: ${spendRow}`);
    }

    const queueRow = psql(`SELECT command FROM atlas_command_queue WHERE idempotency_key='backup-key-1'`);
    if (queueRow.includes('/backup test')) {
      log('PASS', 'Restored atlas_command_queue fixture verified');
    } else {
      log('FAIL', `atlas_command_queue fixture not found: ${queueRow}`);
    }

    // Run full schema assertions on restored DB
    assertSchema();
  } finally {
    teardown();
  }
}

// ── Main ────────────────────────────────────────────────────────────────

function main(): void {
  if (BACKUP_RESTORE) {
    backupRestoreProof();
  } else {
    console.log('=== P1.3 RESTORE DRILL ===');
    console.log(`Container: ${CONTAINER} | Port: ${PORT} | DB: ${DB_NAME}`);
    console.log('');

    try {
      setupContainer();
      applyMigrations();
      assertSchema();
      smokeTests();
    } finally {
      teardown();
    }
  }

  console.log('');
  console.log(`=== DRILL COMPLETE: ${passes} PASS, ${failures} FAIL ===`);

  if (failures > 0) {
    process.exit(1);
  }
}

main();
