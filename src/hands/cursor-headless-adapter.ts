/**
 * adapter.cursor-headless — Cursor Agent CLI executor (quarantine disposable only).
 * Monitors stream-json; waits for terminal result event + process exit; timeout kills.
 * Does not self-verify. Unrestricted --yolo forbidden; sandboxed --force only when explicit.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseExecutorAdapterContract, type ExecutorAdapterContract } from '../core-spine/executor-adapter-contract.js';

export const CURSOR_HEADLESS_ADAPTER_ID = 'adapter.cursor-headless';

export type CursorStreamEvent = {
  raw: string;
  type?: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
};

export type CursorHeadlessLaunchOptions = {
  agentBin: string;
  workspace: string;
  prompt: string;
  timeoutMs: number;
  evidenceDir: string;
  resumeChatId?: string;
  /** Sandboxed allowlist writes only — never --yolo alone. */
  sandboxedForce?: boolean;
  sandboxMode?: 'enabled' | 'disabled';
  model?: string;
  /** When true (default false): Atlas applies writeToolCall proposals inside workspace allowlist. Never implies --force. */
  applyProposedWrites?: boolean;
  /** Relative path globs/prefixes allowed for Atlas-applied proposals (default src/) */
  allowedWritePrefixes?: string[];
  env?: NodeJS.ProcessEnv;
  /** Test seam */
  spawnImpl?: typeof spawn;
  nowMs?: () => number;
};

export type CursorHeadlessRunResult = {
  adapterId: typeof CURSOR_HEADLESS_ADAPTER_ID;
  pid: number | null;
  sessionId: string | null;
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  terminalEventPresent: boolean;
  events: CursorStreamEvent[];
  streamPath: string;
  metaPath: string;
  claimedResultText: string | null;
  error: string | null;
  durationMs: number;
  appliedWrites: string[];
  forceUsed: boolean;
};

export class CursorHeadlessError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'AUTH'
      | 'TIMEOUT'
      | 'NO_TERMINAL_EVENT'
      | 'OUTSIDE_WORKTREE'
      | 'FORCE_UNRESTRICTED'
      | 'SPAWN'
      | 'CONFIG',
  ) {
    super(message);
    this.name = 'CursorHeadlessError';
  }
}

export function buildCursorExecutorContract(input: {
  taskId: string;
  objective: string;
  workspace: string;
  timeoutMs: number;
}): ExecutorAdapterContract {
  return parseExecutorAdapterContract({
    adapterId: CURSOR_HEADLESS_ADAPTER_ID,
    version: '0.1.0',
    capabilities: ['cursor-launch', 'cursor-stream-monitor', 'cursor-resume', 'cursor-cancel'],
    requiredPermissions: ['workspace-write-disposable', 'shell-allowlist'],
    allowedPaths: [input.workspace],
    allowedCommands: ['node', 'npm'],
    networkPolicy: 'deny',
    spendPolicy: { allowPaid: false, maxTokens: 0 },
    inputTaskContract: {
      taskId: input.taskId,
      objective: input.objective,
      declaredEffects: [`edit:${join(input.workspace, 'src', 'counter.js')}`],
    },
    cancellation: { supported: true, signal: 'hard' },
    timeoutMs: input.timeoutMs,
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseLine(line: string): CursorStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) return { raw: line };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      raw: trimmed,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      subtype: typeof obj.subtype === 'string' ? obj.subtype : undefined,
      session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      ...obj,
    };
  } catch {
    return { raw: trimmed };
  }
}

function extractClaimedResult(events: CursorStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'result') {
      if (typeof e.result === 'string') return e.result;
      if (e.result && typeof e.result === 'object' && typeof (e.result as { text?: string }).text === 'string') {
        return (e.result as { text: string }).text;
      }
    }
  }
  return null;
}

function extractSessionId(events: CursorStreamEvent[]): string | null {
  for (const e of events) {
    if (typeof e.session_id === 'string' && e.session_id.length > 0) return e.session_id;
  }
  return null;
}

export function assertCursorLaunchSafe(opts: CursorHeadlessLaunchOptions): void {
  if (!opts.agentBin || !existsSync(opts.agentBin)) {
    throw new CursorHeadlessError(`Cursor Agent CLI not found: ${opts.agentBin}`, 'CONFIG');
  }
  if (!opts.workspace || !existsSync(opts.workspace)) {
    throw new CursorHeadlessError(`workspace missing: ${opts.workspace}`, 'CONFIG');
  }
  if (opts.sandboxMode === 'disabled' && process.platform !== 'win32') {
    throw new CursorHeadlessError('sandbox disabled is forbidden for courier proof on this platform', 'FORCE_UNRESTRICTED');
  }
  if (opts.sandboxedForce) {
    throw new CursorHeadlessError('--force / --yolo is forbidden (courier proof)', 'FORCE_UNRESTRICTED');
  }
}

/**
 * Launch Cursor Agent CLI headless with stream-json monitoring.
 * Fail-closed if process exits without terminal `result` event (unless timed out / killed).
 */
export async function runCursorHeadless(opts: CursorHeadlessLaunchOptions): Promise<CursorHeadlessRunResult> {
  assertCursorLaunchSafe(opts);
  mkdirSync(opts.evidenceDir, { recursive: true });
  const streamPath = join(opts.evidenceDir, `cursor-stream-${Date.now()}.jsonl`);
  const metaPath = join(opts.evidenceDir, `cursor-meta-${Date.now()}.json`);
  const spawnFn = opts.spawnImpl ?? spawn;
  const now = opts.nowMs ?? Date.now;

  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--trust',
    '--workspace',
    opts.workspace,
  ];
  // Cursor OS sandbox is macOS/Linux only. On Windows use allowlist (.cursor/cli.json), never --force.
  const sandboxMode = opts.sandboxMode ?? (process.platform === 'win32' ? 'disabled' : 'enabled');
  if (process.platform === 'win32' && sandboxMode === 'enabled') {
    throw new CursorHeadlessError(
      'sandbox enabled unsupported on Windows — use allowlist mode (sandbox disabled) without --force',
      'CONFIG',
    );
  }
  args.push('--sandbox', sandboxMode);
  // --force / --yolo never added
  if (opts.resumeChatId) {
    args.push('--resume', opts.resumeChatId);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  args.push(opts.prompt);

  const started = now();
  const events: CursorStreamEvent[] = [];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFn(opts.agentBin, args, {
      cwd: opts.workspace,
      env: { ...process.env, ...opts.env, NO_OPEN_BROWSER: '1' },
      windowsHide: true,
      shell: process.platform === 'win32',
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    throw new CursorHeadlessError(`spawn failed: ${err instanceof Error ? err.message : String(err)}`, 'SPAWN');
  }

  const out = createWriteStream(streamPath, { encoding: 'utf8' });
  let stdoutBuf = '';
  let stderrBuf = '';

  const pushChunk = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const text = chunk.toString('utf8');
    if (stream === 'stdout') {
      stdoutBuf += text;
      if (!out.destroyed && out.writable) out.write(text);
      const parts = stdoutBuf.split(/\r?\n/);
      stdoutBuf = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim()) events.push(parseLine(line));
      }
    } else {
      stderrBuf += text;
      if (!out.destroyed && out.writable) out.write(`STDERR:${text}`);
    }
  };

  child.stdout.on('data', (c: Buffer) => pushChunk(c, 'stdout'));
  child.stderr.on('data', (c: Buffer) => pushChunk(c, 'stderr'));

  let timedOut = false;
  let killed = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killed = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000).unref?.();
  }, opts.timeoutMs);

  const exitCode: number | null = await new Promise((resolve) => {
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  if (stdoutBuf.trim()) events.push(parseLine(stdoutBuf));
  out.end();

  const terminalEventPresent = events.some((e) => e.type === 'result');
  const sessionId = extractSessionId(events);
  const claimedResultText = extractClaimedResult(events);
  const durationMs = now() - started;

  let error: string | null = null;
  if (timedOut) error = 'TIMEOUT';
  else if (!terminalEventPresent) error = 'NO_TERMINAL_EVENT';
  else if (exitCode !== 0) error = `EXIT_${exitCode}`;

  if (stderrBuf.toLowerCase().includes('not logged in') || stderrBuf.toLowerCase().includes('authentication')) {
    error = 'AUTH';
  }

  let appliedWrites: string[] = [];
  const forceUsed = false;
  if (opts.applyProposedWrites && !timedOut && terminalEventPresent) {
    appliedWrites = applyProposedWritesFromEvents(
      opts.workspace,
      events,
      opts.allowedWritePrefixes ?? ['src/'],
    );
  }

  const result: CursorHeadlessRunResult = {
    adapterId: CURSOR_HEADLESS_ADAPTER_ID,
    pid: child.pid ?? null,
    sessionId,
    exitCode,
    timedOut,
    killed,
    terminalEventPresent,
    events,
    streamPath,
    metaPath,
    claimedResultText,
    error,
    durationMs,
    appliedWrites,
    forceUsed,
  };

  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        ...result,
        events: undefined,
        eventCount: events.length,
        proposedWritePaths: extractWritePathsFromEvents(events),
        streamSha256: sha256(
          events
            .map((e) => e.raw)
            .join('\n'),
        ),
        promptSha256: sha256(opts.prompt),
        sandboxMode: opts.sandboxMode ?? 'enabled',
        sandboxedForce: false,
        forceUsed,
        resumeChatId: opts.resumeChatId ?? null,
      },
      null,
      2,
    ),
    'utf8',
  );

  if (timedOut) {
    throw new CursorHeadlessError('Cursor hung past timeout — cancelled', 'TIMEOUT');
  }
  if (!terminalEventPresent) {
    throw new CursorHeadlessError('Cursor process ended without terminal stream-json result event', 'NO_TERMINAL_EVENT');
  }
  return result;
}

/**
 * Apply writeToolCall proposals from stream-json into the disposable workspace.
 * Used when --force is forbidden: Cursor proposes, Atlas gates and writes.
 */
export function applyProposedWritesFromEvents(
  workspace: string,
  events: CursorStreamEvent[],
  allowedWritePrefixes: string[] = ['src/'],
): string[] {
  const root = resolve(workspace);
  const applied: string[] = [];
  for (const e of events) {
    const tool = (e as { tool_call?: Record<string, unknown> }).tool_call;
    if (!tool || typeof tool !== 'object') continue;
    const write = (tool as { writeToolCall?: { args?: { path?: string; contents?: string; content?: string; file_path?: string } } })
      .writeToolCall;
    if (!write?.args) continue;
    const relRaw = write.args.path ?? write.args.file_path;
    const contents = write.args.contents ?? write.args.content;
    if (!relRaw || typeof contents !== 'string') continue;
    const rel = relRaw.replace(/\\/g, '/').replace(/^\.\//, '');
    const allowed = allowedWritePrefixes.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p.replace(/\\/g, '/')));
    if (!allowed) {
      throw new CursorHeadlessError(`proposed write outside allowlist: ${rel}`, 'OUTSIDE_WORKTREE');
    }
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep) && !abs.startsWith(root + '/')) {
      throw new CursorHeadlessError(`proposed write escapes workspace: ${rel}`, 'OUTSIDE_WORKTREE');
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
    applied.push(rel);
  }
  return applied;
}

function extractWritePathsFromEvents(events: CursorStreamEvent[]): string[] {
  const paths: string[] = [];
  for (const e of events) {
    const tool = (e as { tool_call?: Record<string, unknown> }).tool_call;
    if (!tool || typeof tool !== 'object') continue;
    const write = (tool as { writeToolCall?: { args?: { path?: string; file_path?: string } } }).writeToolCall;
    const rel = write?.args?.path ?? write?.args?.file_path;
    if (typeof rel === 'string') paths.push(rel);
  }
  return paths;
}

/** Fail-closed helper used by negatives / courier when hang is detected without kill path. */
export function assertTerminalCompletion(result: Pick<CursorHeadlessRunResult, 'terminalEventPresent' | 'exitCode' | 'timedOut'>): void {
  if (result.timedOut) throw new CursorHeadlessError('timed out', 'TIMEOUT');
  if (!result.terminalEventPresent) throw new CursorHeadlessError('missing terminal event', 'NO_TERMINAL_EVENT');
}
