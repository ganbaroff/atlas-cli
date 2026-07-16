/**
 * Atlas policy loader — one declarative guardrail surface over config/policy.yaml.
 *
 * WHAT THIS IS: a single, documented, testable read-model over guardrails that
 * already live in code (shell classifier, fs sensitive-path, spend caps, pause),
 * PLUS the one new behaviour — the autonomy shell whitelist. It does NOT rewrite
 * those modules; shell.ts and fs-guard.ts remain the operative enforcement floor.
 *
 * DESIGN CONTRACTS:
 *   - ENV OVERRIDES WIN over the YAML (redeploy/tests flip a value without rebuild).
 *   - FAIL-CLOSED: if the file is missing/unparseable in production, the autonomy
 *     whitelist is EMPTY (autonomy shell fully denied) and caps use safe defaults.
 *   - NEVER CRASH THE BOOT: js-yaml is loaded via createRequire in a try/catch, and
 *     read/parse is wrapped — a policy problem degrades to the safe default, so
 *     the live Telegram bot / Railway health stay GREEN.
 *   - SYNC: callers (shell classify, spend cap) are synchronous, so this is too.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Sync, catchable YAML load. js-yaml is a production transitive dep (present after
// prune). If it ever goes missing, yamlLib stays null → fail-closed, no crash.
let yamlLib: { load(s: string): unknown } | null = null;
try {
  const req = createRequire(import.meta.url);
  yamlLib = req('js-yaml');
} catch {
  yamlLib = null;
}

export interface AtlasPolicy {
  version: number;
  token: { daily_cap: number; paid_default: boolean; brain_queue_cap: number };
  pause: { env: string };
  shell: { destructive_opt_in_env: string; whitelist_autonomy: string[] };
  fs: { sensitive: string[] };
  billing: { deny: string[] };
  panic: { env: string; telegram_commands: string[] };
}

/** Safe defaults — also the fail-closed posture (empty autonomy whitelist). */
export const DEFAULT_POLICY: AtlasPolicy = {
  version: 1,
  token: { daily_cap: 500_000, paid_default: false, brain_queue_cap: 20 },
  pause: { env: 'ATLAS_PAUSE' },
  shell: { destructive_opt_in_env: 'ATLAS_SHELL_ALLOW_DESTRUCTIVE', whitelist_autonomy: [] },
  fs: { sensitive: [] },
  billing: { deny: [] },
  panic: { env: 'ATLAS_PAUSE', telegram_commands: ['/pause', '/resume'] },
};

function isProduction(): boolean {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * Resolve config/policy.yaml across dev (tsx from repo root), prod (bundled dist,
 * WORKDIR=/app) and the autonomy subprocess (cwd=VOLAURA). Candidates in order:
 *   1. ATLAS_POLICY_PATH (explicit override — tests point this at a fixture)
 *   2. <cwd>/config/policy.yaml
 *   3. walk up from this module's dir looking for config/policy.yaml
 */
export function resolvePolicyPath(): string | null {
  const override = process.env.ATLAS_POLICY_PATH;
  if (override && existsSync(override)) return override;

  const cwdCandidate = resolve(process.cwd(), 'config', 'policy.yaml');
  if (existsSync(cwdCandidate)) return cwdCandidate;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, 'config', 'policy.yaml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Deep-ish merge of a parsed partial over DEFAULT_POLICY (one level per section). */
function mergePolicy(parsed: unknown): AtlasPolicy {
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, any>;
  return {
    version: typeof p.version === 'number' ? p.version : DEFAULT_POLICY.version,
    token: {
      daily_cap: numOr(p.token?.daily_cap, DEFAULT_POLICY.token.daily_cap),
      paid_default: boolOr(p.token?.paid_default, DEFAULT_POLICY.token.paid_default),
      brain_queue_cap: numOr(p.token?.brain_queue_cap, DEFAULT_POLICY.token.brain_queue_cap),
    },
    pause: { env: strOr(p.pause?.env, DEFAULT_POLICY.pause.env) },
    shell: {
      destructive_opt_in_env: strOr(p.shell?.destructive_opt_in_env, DEFAULT_POLICY.shell.destructive_opt_in_env),
      whitelist_autonomy: strArr(p.shell?.whitelist_autonomy),
    },
    fs: { sensitive: strArr(p.fs?.sensitive) },
    billing: { deny: strArr(p.billing?.deny) },
    panic: {
      env: strOr(p.panic?.env, DEFAULT_POLICY.panic.env),
      telegram_commands: p.panic?.telegram_commands ? strArr(p.panic.telegram_commands) : DEFAULT_POLICY.panic.telegram_commands,
    },
  };
}

const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const boolOr = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const strOr = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

let cached: AtlasPolicy | null = null;

/** Load (and cache) the policy. Fail-closed + never throws. */
export function loadPolicy(): AtlasPolicy {
  if (cached) return cached;
  cached = readPolicyFromDisk();
  return cached;
}

function readPolicyFromDisk(): AtlasPolicy {
  try {
    const path = resolvePolicyPath();
    if (!path) {
      if (isProduction()) {
        console.error('[policy] FAIL-CLOSED: config/policy.yaml not found in production — autonomy shell denied, caps at defaults.');
      }
      return DEFAULT_POLICY;
    }
    if (!yamlLib) {
      console.error('[policy] FAIL-CLOSED: js-yaml unavailable — autonomy shell denied, caps at defaults.');
      return DEFAULT_POLICY;
    }
    const raw = readFileSync(path, 'utf8');
    return mergePolicy(yamlLib.load(raw));
  } catch (err) {
    console.error('[policy] FAIL-CLOSED: policy load failed —', (err as Error)?.message);
    return DEFAULT_POLICY;
  }
}

/** Test/hot-reload hook — drop the cache so the next loadPolicy() re-reads disk. */
export function resetPolicyCache(): void {
  cached = null;
}

// ── Accessors (ENV WINS, then policy.yaml, then default) ──────────────────────

/** Daily token cap: ATLAS_DAILY_TOKEN_CAP > policy.token.daily_cap > 500k. */
export function policyDailyTokenCap(): number {
  const raw = process.env.ATLAS_DAILY_TOKEN_CAP;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return loadPolicy().token.daily_cap;
}

let compiledFor: string[] | null = null;
let compiled: RegExp[] = [];

/** Compiled autonomy whitelist regexes (bad patterns are skipped, not fatal). */
export function autonomyShellWhitelist(): RegExp[] {
  const patterns = loadPolicy().shell.whitelist_autonomy;
  if (compiledFor === patterns) return compiled;
  compiled = [];
  for (const p of patterns) {
    try {
      compiled.push(new RegExp(p, 'i'));
    } catch {
      console.error('[policy] skipping invalid autonomy whitelist regex:', p);
    }
  }
  compiledFor = patterns;
  return compiled;
}

/**
 * Is an autonomous actor allowed to run this shell command? True only if it
 * matches a whitelist pattern. Empty whitelist ⇒ always false (fail-closed).
 */
export function isAutonomyShellAllowed(command: string): boolean {
  const cmd = (command || '').trim();
  if (!cmd) return false;
  return autonomyShellWhitelist().some((re) => re.test(cmd));
}
