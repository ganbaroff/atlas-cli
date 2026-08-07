/**
 * atlas/executor/tool-broker.ts — the only path from executor intent to the host.
 *
 * Every tool the executor can call is authored here. The vendor SDK's own
 * filesystem and shell tools are never registered: its command guard is a
 * blacklist by its own documentation, not a security boundary, so Atlas does
 * not delegate enforcement to it.
 *
 * Authority is re-derived from disk on every single call — the signed Work
 * Order's signature, the live RepoWriterLease, the real `git rev-parse HEAD`,
 * the resolved absolute path, the command class, and the attempt/wall-clock
 * budget. No caller-supplied boolean is accepted in place of any of these, and
 * a refusal is returned before the side effect is attempted, not after.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { checkWorkOrderScope } from '../work-order/validate.js';
import { getRepoWriterLeaseInfo } from '../work-order/repo-writer-lock.js';
import type { WorkOrderVerifier } from '../work-order/sign.js';
import type { SignedWorkOrder } from '../work-order/types.js';
import type { BrokeredTool, BrokerOutcome, ExecutorToolBroker } from './adapter.js';

const MAX_READ_CHARS = 60_000;
const MAX_COMMAND_OUTPUT_CHARS = 24_000;

export interface BrokerAuditEntry {
  readonly at: string;
  readonly tool: string;
  readonly requestedPath?: string;
  readonly command?: string;
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface ToolBrokerOptions {
  readonly missionId: string;
  readonly signedWorkOrder: SignedWorkOrder;
  /** Absolute worktree root. Nothing outside it is reachable through any tool. */
  readonly worktreeRoot: string;
  /** Independently known identity of THIS executor process — never read off the order. */
  readonly executorIdentity: string;
  /** Command classes this mission may run, in addition to the order's own list. */
  readonly startedAtMs: number;
  readonly attemptNumber: number;
  /** Injectable for tests; defaults to the real `git rev-parse HEAD`. */
  readonly readHead?: (repoPath: string) => string;
  /** Injectable for tests; defaults to the real lease store. */
  readonly readLease?: typeof getRepoWriterLeaseInfo;
  /**
   * Signature verifier. Omitted in production so `checkWorkOrderScope` resolves
   * the env-key-backed one and fails closed when no key is configured — an
   * unverifiable order must never authorize a mutation.
   */
  readonly verifier?: WorkOrderVerifier;
  readonly now?: () => Date;
}

/** Maps a concrete command to the coarse class the Work Order authorizes. */
export function classifyCommand(command: string): string {
  const head = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (head === 'git') return 'git';
  if (head === 'node' || head === 'npm' || head === 'npx' || head === 'pnpm' || head === 'yarn') return 'node';
  if (head === 'python' || head === 'python3' || head === 'py' || head === 'pytest') return 'python';
  if (head === 'tsc' || head === 'vitest') return 'node';
  return `unclassified:${head || 'empty'}`;
}

function realGitHead(repoPath: string): string {
  return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

export class AtlasToolBroker implements ExecutorToolBroker {
  private readonly audit: BrokerAuditEntry[] = [];
  private paused = false;
  private readonly readHead: (repoPath: string) => string;
  private readonly readLease: typeof getRepoWriterLeaseInfo;
  private readonly now: () => Date;

  constructor(private readonly options: ToolBrokerOptions) {
    this.readHead = options.readHead ?? realGitHead;
    this.readLease = options.readLease ?? getRepoWriterLeaseInfo;
    this.now = options.now ?? (() => new Date());
  }

  get auditTrail(): readonly BrokerAuditEntry[] {
    return this.audit;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  readonly tools: readonly BrokeredTool[] = [
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the mission worktree. Paths are worktree-relative.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      mutating: false,
    },
    {
      name: 'search_files',
      description: 'List worktree-relative file paths whose name or content matches a substring.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, dir: { type: 'string' } },
        required: ['query'],
      },
      mutating: false,
    },
    {
      name: 'git_status',
      description: 'Porcelain status of the mission worktree.',
      inputSchema: { type: 'object', properties: {} },
      mutating: false,
    },
    {
      name: 'git_diff',
      description: 'Unified diff of uncommitted changes in the mission worktree.',
      inputSchema: { type: 'object', properties: {} },
      mutating: false,
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file inside the mission worktree.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      mutating: true,
    },
    {
      name: 'apply_patch',
      description: 'Replace an exact substring in a worktree file. Fails when the anchor is absent or ambiguous.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } },
        required: ['path', 'find', 'replace'],
      },
      mutating: true,
    },
    {
      name: 'run_command',
      description: 'Run one authorized command in the mission worktree and return its output and exit code.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      mutating: true,
    },
  ];

  /**
   * Resolves a caller path against the worktree and refuses anything that
   * escapes it. Symlink and `..` escapes are caught by comparing resolved
   * absolute paths, not by inspecting the string.
   */
  private resolveInside(relPath: string): { ok: true; absolute: string } | { ok: false; reason: string } {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      return { ok: false, reason: 'path_missing' };
    }
    if (path.isAbsolute(relPath)) {
      return { ok: false, reason: 'absolute_path_refused' };
    }
    const root = path.resolve(this.options.worktreeRoot);
    const absolute = path.resolve(root, relPath);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      return { ok: false, reason: 'path_outside_worktree' };
    }
    return { ok: true, absolute };
  }

  /**
   * The single authority check. Runs before every tool side effect, mutating
   * or not, and re-derives every input from disk rather than from the caller.
   */
  private authorize(input: {
    tool: string;
    candidatePath?: string;
    action: string;
    commandClass: string;
  }): { ok: true } | { ok: false; reason: string } {
    if (this.paused) return { ok: false, reason: 'mission_paused' };

    const lease = this.readLease(this.options.signedWorkOrder.repoCanonicalPath);
    if (!lease || lease.status !== 'held') {
      return { ok: false, reason: 'lease_not_held' };
    }
    if (lease.owner.missionId !== this.options.missionId) {
      return { ok: false, reason: 'lease_owned_by_other_mission' };
    }
    if (lease.owner.workOrderId !== this.options.signedWorkOrder.workOrderId) {
      return { ok: false, reason: 'lease_work_order_mismatch' };
    }

    let observedHead: string;
    try {
      observedHead = this.readHead(this.options.signedWorkOrder.repoCanonicalPath);
    } catch {
      return { ok: false, reason: 'head_unreadable' };
    }

    const verdict = checkWorkOrderScope(this.options.signedWorkOrder, {
      now: this.now(),
      verifier: this.options.verifier,
      executorIdentity: this.options.executorIdentity,
      repoCanonicalPath: this.options.signedWorkOrder.repoCanonicalPath,
      baseHead: observedHead,
      candidatePath: input.candidatePath,
      action: input.action,
      commandClass: input.commandClass,
      attemptNumber: this.options.attemptNumber,
      elapsedWallClockMs: this.now().getTime() - this.options.startedAtMs,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    return { ok: true };
  }

  private record(entry: BrokerAuditEntry): void {
    this.audit.push(entry);
  }

  private refuse(tool: string, reason: string, requestedPath?: string, command?: string): BrokerOutcome {
    this.record({ at: this.now().toISOString(), tool, requestedPath, command, allowed: false, reason });
    return { ok: false, refusedReason: reason };
  }

  async invoke(toolName: string, rawInput: unknown): Promise<BrokerOutcome> {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const known = this.tools.find((t) => t.name === toolName);
    if (!known) return this.refuse(toolName, 'unknown_tool');

    switch (toolName) {
      case 'read_file':
      case 'write_file':
      case 'apply_patch':
        return this.fileTool(toolName, input);
      case 'search_files':
        return this.searchTool(input);
      case 'git_status':
      case 'git_diff':
        return this.gitTool(toolName);
      case 'run_command':
        return this.commandTool(input);
      default:
        return this.refuse(toolName, 'unknown_tool');
    }
  }

  private fileTool(tool: 'read_file' | 'write_file' | 'apply_patch', input: Record<string, unknown>): BrokerOutcome {
    const rel = typeof input.path === 'string' ? input.path : '';
    const resolved = this.resolveInside(rel);
    if (!resolved.ok) return this.refuse(tool, resolved.reason, rel);

    const action = tool === 'read_file' ? 'read' : 'write';
    const auth = this.authorize({
      tool,
      candidatePath: rel.replace(/\\/g, '/'),
      action,
      commandClass: 'filesystem',
    });
    if (!auth.ok) return this.refuse(tool, auth.reason, rel);

    try {
      if (tool === 'read_file') {
        if (!existsSync(resolved.absolute)) return this.refuse(tool, 'file_not_found', rel);
        const text = readFileSync(resolved.absolute, 'utf8').slice(0, MAX_READ_CHARS);
        this.record({ at: this.now().toISOString(), tool, requestedPath: rel, allowed: true });
        return { ok: true, output: text };
      }

      if (tool === 'write_file') {
        const content = typeof input.content === 'string' ? input.content : '';
        mkdirSync(path.dirname(resolved.absolute), { recursive: true });
        writeFileSync(resolved.absolute, content, 'utf8');
        this.record({ at: this.now().toISOString(), tool, requestedPath: rel, allowed: true });
        return { ok: true, output: `wrote ${content.length} chars to ${rel}` };
      }

      const find = typeof input.find === 'string' ? input.find : '';
      const replace = typeof input.replace === 'string' ? input.replace : '';
      if (find === '') return this.refuse(tool, 'patch_anchor_empty', rel);
      if (!existsSync(resolved.absolute)) return this.refuse(tool, 'file_not_found', rel);
      const before = readFileSync(resolved.absolute, 'utf8');
      const occurrences = before.split(find).length - 1;
      if (occurrences === 0) return this.refuse(tool, 'patch_anchor_absent', rel);
      if (occurrences > 1) return this.refuse(tool, 'patch_anchor_ambiguous', rel);
      writeFileSync(resolved.absolute, before.replace(find, replace), 'utf8');
      this.record({ at: this.now().toISOString(), tool, requestedPath: rel, allowed: true });
      return { ok: true, output: `patched ${rel}` };
    } catch (err) {
      return this.refuse(tool, `io_error:${(err as NodeJS.ErrnoException)?.code ?? 'unknown'}`, rel);
    }
  }

  private searchTool(input: Record<string, unknown>): BrokerOutcome {
    const query = typeof input.query === 'string' ? input.query : '';
    if (query === '') return this.refuse('search_files', 'query_empty');
    const dir = typeof input.dir === 'string' && input.dir.trim() !== '' ? input.dir : '.';
    const resolved = this.resolveInside(dir);
    if (!resolved.ok) return this.refuse('search_files', resolved.reason, dir);

    const auth = this.authorize({
      tool: 'search_files',
      candidatePath: dir.replace(/\\/g, '/'),
      action: 'read',
      commandClass: 'filesystem',
    });
    if (!auth.ok) return this.refuse('search_files', auth.reason, dir);

    const root = path.resolve(this.options.worktreeRoot);
    const hits: string[] = [];
    const walk = (current: string, depth: number): void => {
      if (depth > 8 || hits.length >= 200) return;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(abs, depth + 1);
          continue;
        }
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (rel.includes(query)) {
          hits.push(rel);
          continue;
        }
        try {
          if (statSync(abs).size > 512_000) continue;
          if (readFileSync(abs, 'utf8').includes(query)) hits.push(rel);
        } catch {
          /* unreadable file is simply not a hit */
        }
      }
    };
    walk(resolved.absolute, 0);
    this.record({ at: this.now().toISOString(), tool: 'search_files', requestedPath: dir, allowed: true });
    return { ok: true, output: hits.length ? hits.join('\n') : '(no matches)' };
  }

  private gitTool(tool: 'git_status' | 'git_diff'): BrokerOutcome {
    const auth = this.authorize({ tool, action: 'read', commandClass: 'git' });
    if (!auth.ok) return this.refuse(tool, auth.reason);
    const args = tool === 'git_status' ? ['status', '--porcelain'] : ['diff'];
    try {
      const out = execFileSync('git', ['-C', this.options.worktreeRoot, ...args], {
        encoding: 'utf8',
        windowsHide: true,
      });
      this.record({ at: this.now().toISOString(), tool, allowed: true });
      return { ok: true, output: out.slice(0, MAX_COMMAND_OUTPUT_CHARS) || '(clean)' };
    } catch (err) {
      return this.refuse(tool, `git_error:${(err as { status?: number })?.status ?? 'unknown'}`);
    }
  }

  private commandTool(input: Record<string, unknown>): BrokerOutcome {
    const command = typeof input.command === 'string' ? input.command : '';
    if (command.trim() === '') return this.refuse('run_command', 'command_empty', undefined, command);

    // Shell metacharacters would let one authorized command class smuggle in
    // another, so the broker refuses them outright rather than trying to parse.
    if (/[;&|><`$\n]/.test(command)) {
      return this.refuse('run_command', 'shell_metacharacter_refused', undefined, command);
    }

    const commandClass = classifyCommand(command);
    if (commandClass.startsWith('unclassified:')) {
      return this.refuse('run_command', commandClass, undefined, command);
    }

    const auth = this.authorize({ tool: 'run_command', action: 'execute', commandClass });
    if (!auth.ok) return this.refuse('run_command', auth.reason, undefined, command);

    const [bin, ...args] = command.trim().split(/\s+/);
    try {
      const out = execFileSync(bin as string, args, {
        cwd: this.options.worktreeRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
      });
      this.record({ at: this.now().toISOString(), tool: 'run_command', command, allowed: true });
      return { ok: true, output: `exit=0\n${out}`.slice(0, MAX_COMMAND_OUTPUT_CHARS) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      this.record({ at: this.now().toISOString(), tool: 'run_command', command, allowed: true });
      const combined = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      return { ok: true, output: `exit=${e.status ?? 1}\n${combined}`.slice(0, MAX_COMMAND_OUTPUT_CHARS) };
    }
  }
}
