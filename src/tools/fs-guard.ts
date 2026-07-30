/**
 * Shared filesystem governance for read-file / write-file tools: a pure path
 * classifier plus an append-only audit trail, mirroring shell.ts's
 * classifyShellCommand/audit() pattern for the filesystem tool surface
 * (board hardening pass 2026-07-11, Rank 8/9).
 *
 * read-file.ts and write-file.ts previously had NO governance at all — unlike
 * shell.ts, they could read or overwrite any absolute path (including .env,
 * private keys, .git internals) with zero audit trail. An injected agent
 * (e.g. via surf's web text) could exfiltrate secrets through readFile or
 * clobber config through writeFile. This closes that gap.
 */

import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveMigratingStateFile } from '../atlas/state-root.js';

/**
 * Pure, testable classifier. True for paths that must never be read or
 * written without an explicit destructive opt-in: dotenv files, anything
 * under a secrets/ or keys/ directory, PEM/key material, SSH private keys,
 * and git internals. Matches on path segments/basename (not a raw substring),
 * so an unrelated path like /home/user/my-secrets-talk/notes.txt is NOT flagged.
 */
export function isSensitivePath(p: string): boolean {
  const normalized = (p || '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments[segments.length - 1] || '';

  if (/^\.env(\..*)?$/i.test(basename)) return true; // .env, .env.local, .env.production...
  if (/\.pem$/i.test(basename)) return true;
  if (/\.key$/i.test(basename)) return true;
  if (basename === 'id_rsa') return true;
  if (segments.some((s) => s.toLowerCase() === 'secrets' || s.toLowerCase() === 'keys')) return true;
  if (segments.some((s) => s.toLowerCase() === '.git')) return true;

  return false;
}

// ── Actor resolution (mirrors shell.ts resolveShellActor, kept here to avoid circular deps) ──

export type FsActor = 'ceo' | 'autonomy';

export function resolveFsActor(): FsActor {
  const id = (process.env.ATLAS_AGENT_ID || '').trim().toLowerCase();
  if (id === 'autonomy' || (process.env.ATLAS_AUTONOMY || '').trim() === '1') return 'autonomy';
  return 'ceo';
}

// ── Workspace confinement (autonomy actor only) ──────────────────────────────

function resolveWorkspaceRoot(): string {
  return resolve(process.env.ATLAS_WORKSPACE_ROOT || process.cwd());
}

/**
 * Check whether a write to `targetPath` is allowed for the current actor.
 * Autonomy actors are confined to the workspace root — the resolved path must
 * start with the resolved workspace root + separator (or be the root itself).
 * Non-autonomy actors are always allowed (existing behavior).
 */
export function checkWorkspaceConfinement(targetPath: string): { allowed: boolean; reason?: string } {
  const actor = resolveFsActor();
  if (actor !== 'autonomy') return { allowed: true };

  const root = resolveWorkspaceRoot();
  const resolved = resolve(targetPath);
  const normalizedRoot = root.replace(/\\/g, '/');
  const normalizedResolved = resolved.replace(/\\/g, '/');

  if (normalizedResolved === normalizedRoot || normalizedResolved.startsWith(normalizedRoot + '/')) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `[atlas-fs] REFUSED: autonomy actor confined to workspace root (${root}). Path resolves outside: ${resolved}`,
  };
}

/** Same file/shape as shell.ts's audit log by default, so fs + shell governance share one JSONL stream. */
export function auditLogPath(): string {
  return resolveMigratingStateFile(
    'shell-audit',
    'shell-audit.jsonl',
    () => join(tmpdir(), 'atlas-shell-audit.jsonl'),
    'ATLAS_SHELL_AUDIT_LOG',
  );
}

/** Append-only audit trail for filesystem tool operations. Best-effort: never throws into execution. */
export async function auditFsOp(entry: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(auditLogPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    /* logging must never break the tool */
  }
}
