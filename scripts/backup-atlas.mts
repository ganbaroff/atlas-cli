/**
 * P1.2 Backup Job — produces a dated archive of Atlas state + DB export.
 *
 * Usage: node --import tsx scripts/backup-atlas.mts
 *        node --import tsx scripts/backup-atlas.mts --dest /path/to/backups --keep 7
 *
 * Env vars (all optional):
 *   ATLAS_BACKUP_DIR   — destination root (default ~/AtlasBackups)
 *   ATLAS_BACKUP_KEEP  — how many dated dirs to retain (default 14)
 *   DATABASE_URL       — postgres connection string for logical DB export
 *   ATLAS_EXEC_GRAPH_DIR, ATLAS_GOAL_BUDGET_DIR, ATLAS_EVIDENCE_DIR,
 *   ATLAS_SPEND_RECEIPT_DIR, ATLAS_STATE_DIR — state dir overrides
 *
 * Exit codes:
 *   0 — success (DB part may be SKIPPED if DATABASE_URL absent)
 *   1 — state-dirs archival failed
 */

import { execSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// ── CLI args (simple positional parsing) ────────────────────────────────

const args = process.argv.slice(2);
function argVal(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

// ── Config ──────────────────────────────────────────────────────────────

const BACKUP_ROOT = resolve(
  argVal('dest') ?? process.env.ATLAS_BACKUP_DIR ?? join(homedir(), 'AtlasBackups'),
);
const KEEP = parseInt(argVal('keep') ?? process.env.ATLAS_BACKUP_KEEP ?? '14', 10);
const DATABASE_URL = process.env.DATABASE_URL;

const TABLES = [
  'atlas_learnings', 'learning_decisions', 'learning_outcomes',
  'bot_sessions', 'bot_messages', 'bot_heartbeats',
  'atlas_command_queue', 'llm_spend',
];

const PREFIX = 'atlas-backup-';

// ── Repo root resolution ────────────────────────────────────────────────

function resolveRepoRoot(): string {
  let dir = resolve(import.meta.dirname!);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve('.');
}

const REPO_ROOT = resolveRepoRoot();

// ── State dir resolution (mirrors production resolvers) ─────────────────

interface StateSource {
  name: string;
  path: string;
  envName?: string;
}

function resolveStateDirs(): StateSource[] {
  const dirs: StateSource[] = [];

  // 1. exec-graph: ATLAS_EXEC_GRAPH_DIR or state/exec-graph
  dirs.push({
    name: 'exec-graph',
    path: process.env.ATLAS_EXEC_GRAPH_DIR
      ? resolve(process.env.ATLAS_EXEC_GRAPH_DIR)
      : join(REPO_ROOT, 'state', 'exec-graph'),
    envName: 'ATLAS_EXEC_GRAPH_DIR',
  });

  // 2. goal-budgets: ATLAS_GOAL_BUDGET_DIR or state/goal-budgets
  dirs.push({
    name: 'goal-budgets',
    path: process.env.ATLAS_GOAL_BUDGET_DIR
      ? resolve(process.env.ATLAS_GOAL_BUDGET_DIR)
      : join(REPO_ROOT, 'state', 'goal-budgets'),
    envName: 'ATLAS_GOAL_BUDGET_DIR',
  });

  // 3. evidence: ATLAS_EVIDENCE_DIR or state/evidence
  dirs.push({
    name: 'evidence',
    path: process.env.ATLAS_EVIDENCE_DIR
      ? resolve(process.env.ATLAS_EVIDENCE_DIR)
      : join(REPO_ROOT, 'state', 'evidence'),
    envName: 'ATLAS_EVIDENCE_DIR',
  });

  // 4. intake-drafts: hardcoded state/intake-drafts
  dirs.push({
    name: 'intake-drafts',
    path: join(REPO_ROOT, 'state', 'intake-drafts'),
  });

  // 5. swarm-runs: hardcoded state/swarm-runs
  dirs.push({
    name: 'swarm-runs',
    path: join(REPO_ROOT, 'state', 'swarm-runs'),
  });

  // 6. spend-receipts: ATLAS_SPEND_RECEIPT_DIR or ~/.atlas
  dirs.push({
    name: 'spend-receipts',
    path: process.env.ATLAS_SPEND_RECEIPT_DIR
      ? resolve(process.env.ATLAS_SPEND_RECEIPT_DIR)
      : join(homedir(), '.atlas'),
    envName: 'ATLAS_SPEND_RECEIPT_DIR',
  });

  // 7. runner-state (nonce ledger): ATLAS_STATE_DIR or ~/.atlas
  // Same default as spend-receipts; if identical path, we only copy once
  const runnerPath = process.env.ATLAS_STATE_DIR
    ? resolve(process.env.ATLAS_STATE_DIR)
    : join(homedir(), '.atlas');
  // Only add if different from spend-receipts
  if (runnerPath !== dirs[dirs.length - 1].path) {
    dirs.push({
      name: 'runner-state',
      path: runnerPath,
      envName: 'ATLAS_STATE_DIR',
    });
  }

  return dirs;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isoTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function gitHead(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8', cwd: REPO_ROOT, timeout: 10_000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      try {
        total += statSync(join(entry.parentPath ?? entry.path, entry.name)).size;
      } catch { /* skip unreadable */ }
    }
  }
  return total;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function log(level: 'INFO' | 'WARN' | 'SKIP' | 'OK' | 'FAIL', msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${level}: ${msg}`);
}

// ── Safety checks ───────────────────────────────────────────────────────

function ensureDestOutsideRepo(dest: string): void {
  const normDest = resolve(dest).toLowerCase();
  const normRepo = resolve(REPO_ROOT).toLowerCase();
  if (normDest.startsWith(normRepo + '/') || normDest.startsWith(normRepo + '\\') || normDest === normRepo) {
    console.error(`FATAL: backup destination ${dest} resolves INSIDE the repo ${REPO_ROOT}. Refusing.`);
    process.exit(1);
  }
}

// ── State-dirs archive ──────────────────────────────────────────────────

function archiveStateDirs(backupDir: string): { entries: Record<string, { size: string; files: number }>; ok: boolean } {
  const stateArchiveDir = join(backupDir, 'state-dirs');
  mkdirSync(stateArchiveDir, { recursive: true });

  const entries: Record<string, { size: string; files: number }> = {};
  const sources = resolveStateDirs();
  let anyFailed = false;

  for (const src of sources) {
    if (!existsSync(src.path)) {
      log('SKIP', `${src.name}: ${src.path} does not exist`);
      entries[src.name] = { size: '0 B', files: 0 };
      continue;
    }

    // Do not follow symlinks
    const stat = lstatSync(src.path);
    if (stat.isSymbolicLink()) {
      log('SKIP', `${src.name}: ${src.path} is a symlink (safety: not following)`);
      entries[src.name] = { size: '0 B', files: 0 };
      continue;
    }

    const destDir = join(stateArchiveDir, src.name);
    try {
      cpSync(src.path, destDir, { recursive: true, dereference: false });
      const size = dirSizeBytes(destDir);
      const fileCount = readdirSync(destDir, { recursive: true, withFileTypes: true })
        .filter(e => e.isFile()).length;
      entries[src.name] = { size: humanSize(size), files: fileCount };
      log('OK', `${src.name}: ${fileCount} files, ${humanSize(size)}`);
    } catch (e: any) {
      log('FAIL', `${src.name}: copy failed — ${e.message?.slice(0, 200)}`);
      entries[src.name] = { size: 'FAILED', files: 0 };
      anyFailed = true;
    }
  }

  return { entries, ok: !anyFailed };
}

// ── DB export ───────────────────────────────────────────────────────────

function exportDatabase(backupDir: string): { tables: Record<string, string>; skipped: boolean } {
  const dbExportDir = join(backupDir, 'db-export');
  const result: Record<string, string> = {};

  if (!DATABASE_URL) {
    log('SKIP', 'DATABASE_URL not set — DB export skipped (state-dirs still archived)');
    return { tables: {}, skipped: true };
  }

  mkdirSync(dbExportDir, { recursive: true });
  let anyFailed = false;

  for (const table of TABLES) {
    const outFile = join(dbExportDir, `${table}.csv`);
    try {
      execSync(
        `psql "${DATABASE_URL}" -c "\\COPY ${table} TO STDOUT WITH (FORMAT csv, HEADER)" > "${outFile.replace(/\\/g, '/')}"`,
        { encoding: 'utf-8', timeout: 120_000 },
      );
      const size = statSync(outFile).size;
      result[table] = humanSize(size);
      log('OK', `DB export ${table}: ${humanSize(size)}`);
    } catch (e: any) {
      log('FAIL', `DB export ${table} failed: ${e.message?.slice(0, 200)}`);
      result[table] = 'FAILED';
      anyFailed = true;
    }
  }

  if (anyFailed) {
    log('WARN', 'Some DB table exports failed — archive is partial');
  }
  return { tables: result, skipped: false };
}

// ── Retention ───────────────────────────────────────────────────────────

function enforceRetention(): void {
  if (!existsSync(BACKUP_ROOT)) return;

  const entries = readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter(e => {
      if (!e.isDirectory()) return false;
      if (!e.name.startsWith(PREFIX)) return false;
      // Safety: never follow symlinks
      const full = join(BACKUP_ROOT, e.name);
      return !lstatSync(full).isSymbolicLink();
    })
    .map(e => e.name)
    .sort(); // ISO timestamps sort lexicographically

  if (entries.length <= KEEP) {
    log('INFO', `Retention: ${entries.length} backups present, keep=${KEEP} — nothing to prune`);
    return;
  }

  const toDelete = entries.slice(0, entries.length - KEEP);
  for (const name of toDelete) {
    const fullPath = join(BACKUP_ROOT, name);
    log('INFO', `Retention: removing old backup ${name}`);
    rmSync(fullPath, { recursive: true, force: true });
  }
  log('OK', `Retention: pruned ${toDelete.length} old backups, ${KEEP} remain`);
}

// ── Main ────────────────────────────────────────────────────────────────

function main(): void {
  console.log('=== ATLAS BACKUP JOB ===');
  console.log(`Destination root: ${BACKUP_ROOT}`);
  console.log(`Retention: keep newest ${KEEP}`);
  console.log('');

  // Safety: destination must not be inside the repo
  ensureDestOutsideRepo(BACKUP_ROOT);

  const stamp = isoTimestamp();
  const backupDir = join(BACKUP_ROOT, `${PREFIX}${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  log('INFO', `Backup dir: ${backupDir}`);

  // 1. Archive state dirs
  const { entries: stateEntries, ok: stateOk } = archiveStateDirs(backupDir);

  // 2. Export database
  const { tables: dbTables, skipped: dbSkipped } = exportDatabase(backupDir);

  // 3. Write MANIFEST.json
  const manifest = {
    created: new Date().toISOString(),
    machine: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown',
    gitHead: gitHead(),
    repoRoot: REPO_ROOT,
    stateDirs: stateEntries,
    dbExport: dbSkipped ? 'SKIPPED (DATABASE_URL not set)' : dbTables,
    retentionKeep: KEEP,
  };

  const manifestPath = join(backupDir, 'MANIFEST.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  log('OK', `MANIFEST.json written`);

  // 4. Retention
  enforceRetention();

  // 5. Summary
  console.log('');
  console.log('=== BACKUP COMPLETE ===');
  console.log(`Archive: ${backupDir}`);
  if (dbSkipped) {
    console.log('WARNING: DB export was SKIPPED (DATABASE_URL not set). State dirs only.');
  }

  if (!stateOk) {
    console.error('ERROR: state-dirs archival had failures — exit 1');
    process.exit(1);
  }
}

main();
