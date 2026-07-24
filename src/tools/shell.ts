import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAutonomyShellAllowed } from '../atlas/policy.js';

const execAsync = promisify(exec);
const TIMEOUT_MS = 30_000;

export type ShellDecision = 'allow' | 'gated' | 'blocked';

/**
 * BLOCKED — catastrophic, irreversible commands. NEVER executed, even with
 * the destructive opt-in set. This is the hard floor under the shell RCE
 * surface that 6 of the 9 audit books flagged P0 (2026-07-09 overhaul, Rank 1).
 * It also blunts the surf→shell prompt-injection path (Rank 9): an injected
 * `rm -rf /` from untrusted web text is refused before it can run.
 */
const BLOCKED: Array<{ rule: string; re: RegExp }> = [
  { rule: 'recursive delete of filesystem root / home / wildcard', re: /\brm\s+-\S*[rf]\S*\s+\S*(?:\/|~|\/\*|\*|\$HOME)(?:\s|$)/i },
  { rule: 'disk format / raw device write', re: /\b(?:mkfs\w*|diskpart)\b|\bformat\s+[a-z]:|\bdd\b[^\n]*\bof=\/dev\/|>\s*\/dev\/(?:sd|hd|nvme|disk)/i },
  { rule: 'power state change (shutdown/reboot)', re: /\b(?:shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/i },
  { rule: 'pipe a download straight into an interpreter', re: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python\d?|node|iex|invoke-expression)\b/i },
  { rule: 'pipe into a privileged shell', re: /\|\s*sudo\s+(?:bash|sh|zsh)\b/i },
  { rule: 'fork bomb', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { rule: 'windows recursive system delete', re: /\b(?:del|rmdir|rd)\b[^\n]*\/[sq][^\n]*(?:c:|%system)/i },
  { rule: 'recursive chmod/chown on filesystem root', re: /\bch(?:mod|own)\s+-R\b[^\n]*\s\/(?:\s|$)/i },
  { rule: 'user / credential management', re: /\b(?:useradd|userdel|passwd|net\s+user)\b/i },
];

/**
 * GATED — destructive but sometimes-legitimate. Executed ONLY when the caller
 * has explicitly opted in via ATLAS_SHELL_ALLOW_DESTRUCTIVE=1 (default OFF, so
 * the unattended autonomousBrainLoop / task-spawner cannot run these).
 */
const GATED: Array<{ rule: string; re: RegExp }> = [
  { rule: 'recursive/forced delete', re: /\b(?:rm\s+-\S*[rf]|rmdir\b|rd\s+\/s|del\s+\/[sq])/i },
  { rule: 'destructive git (reset --hard / clean -f / force push)', re: /\bgit\s+(?:reset\s+--hard|clean\s+-\S*f|push\b[^\n]*(?:--force|-f)\b)/i },
  { rule: 'process kill', re: /\b(?:kill|pkill|killall|taskkill)\b/i },
  { rule: 'package publish', re: /\b(?:npm|pnpm|yarn)\s+publish\b/i },
  { rule: 'docker / service teardown', re: /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+rm)\b|\b(?:systemctl|service)\s+\S+\s+(?:stop|restart)\b/i },
  { rule: 'move into a system directory', re: /\bmv\b[^\n]*\s\/(?:etc|usr|bin|boot|var|lib)\b/i },
];

/**
 * Pure, testable classifier. BLOCKED wins over GATED wins over allow.
 */
export function classifyShellCommand(command: string): { decision: ShellDecision; rule: string } {
  const cmd = (command || '').trim();
  if (!cmd) return { decision: 'allow', rule: 'empty' };
  for (const { rule, re } of BLOCKED) if (re.test(cmd)) return { decision: 'blocked', rule };
  for (const { rule, re } of GATED) if (re.test(cmd)) return { decision: 'gated', rule };
  return { decision: 'allow', rule: 'default-allow' };
}

export type ShellActor = 'ceo' | 'autonomy';

/**
 * Who is invoking the shell? AUTONOMY = an unattended actor (task-spawner
 * subprocess / brain-loop / swarm) that tags itself via ATLAS_AGENT_ID=autonomy
 * (or ATLAS_AUTONOMY=1). Everything else (CEO Telegram turn, interactive CLI) is
 * CEO. The autonomy subprocess runs with its OWN env (see task-spawner.ts), so
 * this env-based resolution is race-free — the in-process CEO path never sets it.
 */
export function resolveShellActor(): ShellActor {
  const id = (process.env.ATLAS_AGENT_ID || '').trim().toLowerCase();
  if (id === 'autonomy' || (process.env.ATLAS_AUTONOMY || '').trim() === '1') return 'autonomy';
  return 'ceo';
}

/**
 * Actor-aware classification (HYBRID policy). The BLOCKED/GATED denylist is the
 * hard floor for EVERY actor. On top of that floor, an AUTONOMY actor may only
 * run commands the policy whitelist permits — an otherwise-allowed command that
 * is not whitelisted is denied for autonomy. CEO turns are unaffected.
 */
export function classifyShellForActor(
  command: string,
  actor: ShellActor,
): { decision: ShellDecision; rule: string } {
  const base = classifyShellCommand(command);
  if (base.decision !== 'allow') return base; // denylist floor wins for everyone
  if (actor === 'autonomy' && !isAutonomyShellAllowed(command)) {
    return { decision: 'blocked', rule: 'autonomy-not-whitelisted' };
  }
  return base;
}

const AUDIT_LOG = process.env.ATLAS_SHELL_AUDIT_LOG || join(tmpdir(), 'atlas-shell-audit.jsonl');

/** Append-only audit trail with agent attribution. Best-effort: never throws into execution. */
async function audit(entry: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    /* logging must never break the tool */
  }
}

const destructiveAllowed = (): boolean => process.env.ATLAS_SHELL_ALLOW_DESTRUCTIVE === '1';

export const shellTool = createTool({
  id: 'shell',
  description:
    'Execute a shell command. Returns stdout/stderr/exitCode (30s timeout). ' +
    'Catastrophic commands (rm -rf /, disk format, shutdown, pipe-to-shell) are always blocked; ' +
    'destructive ones (rm -rf, git reset --hard, force push, kill, publish) require ATLAS_SHELL_ALLOW_DESTRUCTIVE=1.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    cwd: z.string().optional().describe('Working directory'),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
  }),
  execute: async ({ command, cwd }) => {
    const agent = process.env.ATLAS_AGENT_ID || 'unknown';
    const actor = resolveShellActor();
    const { decision, rule } = classifyShellForActor(command, actor);

    if (decision === 'blocked') {
      await audit({ agent, actor, command, cwd, decision, rule });
      const reason = rule === 'autonomy-not-whitelisted'
        ? 'not on the autonomy shell whitelist (policy.yaml) and no CEO turn is active'
        : 'command is catastrophic';
      return {
        stdout: '',
        stderr: `[atlas-shell] BLOCKED (${rule}): ${reason} — not executed.`,
        exitCode: 126,
      };
    }

    if (decision === 'gated' && !destructiveAllowed()) {
      await audit({ agent, actor, command, cwd, decision: 'gated-denied', rule });
      return {
        stdout: '',
        stderr: `[atlas-shell] REFUSED (${rule}): destructive command blocked by default. Set ATLAS_SHELL_ALLOW_DESTRUCTIVE=1 to permit.`,
        exitCode: 126,
      };
    }

    await audit({ agent, actor, command, cwd, decision: decision === 'gated' ? 'gated-allowed' : 'allow', rule });
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd || process.cwd(),
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout || '',
        stderr: e.stderr || String(err),
        exitCode: e.code || 1,
      };
    }
  },
});
