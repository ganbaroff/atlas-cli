/**
 * Notepad process ownership — launch, bind, refuse foreign PIDs, cleanup.
 * Uses CreateProcess-style spawn of notepad.exe with fixture path only.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ProcessOwnership } from './types.js';
import { sha256Hex } from './policy.js';

function resolveHelper(name: string): string | null {
  const override = process.env.ATLAS_DESKTOP_HELPER_DIR;
  const rel = join('apps', 'desktop', name);
  const candidates = [
    override ? join(override, name) : null,
    resolve(process.cwd(), rel),
  ];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    candidates.push(resolve(dir, '..', '..', '..', rel));
    candidates.push(resolve(dir, rel));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function runPs(scriptPath: string, args: string[], timeoutMs = 30_000): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((finish, fail) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const t = setTimeout(() => {
      proc.kill();
      fail(new Error(`powershell timeout ${scriptPath}`));
    }, timeoutMs);
    proc.stdout?.on('data', (c: Buffer) => out.push(c));
    proc.stderr?.on('data', (c: Buffer) => err.push(c));
    proc.on('error', (e) => {
      clearTimeout(t);
      fail(e);
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      finish({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

export function resolveNotepadExecutable(): string {
  const candidates = [
    process.env.ATLAS_NOTEPAD_PATH,
    'C:\\Windows\\System32\\notepad.exe',
    'C:\\Windows\\notepad.exe',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'notepad.exe';
}

export async function launchOwnedNotepad(fixturePath: string): Promise<ProcessOwnership> {
  const absFixture = resolve(fixturePath);
  if (!existsSync(absFixture)) throw new Error(`fixture_missing: ${absFixture}`);
  const exe = resolveNotepadExecutable();
  const launchScript = resolveHelper('notepad-launch-bind.ps1');
  if (!launchScript) throw new Error('notepad-launch-bind.ps1 missing');

  const r = await runPs(
    launchScript,
    ['-FixturePath', absFixture, '-NotepadPath', exe],
    45_000,
  );
  if (r.code !== 0) {
    throw new Error(`notepad_window_bind_failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  try {
    const meta = JSON.parse(r.stdout.trim());
    if (!meta.hwnd || !meta.pid) {
      throw new Error(`bind_incomplete: ${r.stdout.slice(0, 200)}`);
    }
    return {
      pid: Number(meta.pid),
      executablePath: String(meta.executablePath || exe),
      launchTimestamp: String(meta.launchTimestamp || new Date().toISOString()),
      fixturePath: absFixture,
      windowHandle: String(meta.hwnd),
      windowTitle: String(meta.title ?? ''),
    };
  } catch (e) {
    throw new Error(`notepad_bind_parse_failed: ${(e as Error).message} stdout=${r.stdout.slice(0, 200)}`);
  }
}

export async function readFirstLineUia(ownership: ProcessOwnership): Promise<{
  firstLine: string;
  treeExcerpt: string;
} | null> {
  const script = resolveHelper('notepad-uia-read.ps1');
  if (!script) throw new Error('notepad-uia-read.ps1 missing');
  const r = await runPs(script, [
    '-TargetPid',
    String(ownership.pid),
    '-Hwnd',
    ownership.windowHandle,
    '-ExpectedTitleSubstring',
    ownership.windowTitle.slice(0, 40) || 'notepad',
  ]);
  if (r.code !== 0) return null;
  try {
    const meta = JSON.parse(r.stdout.trim());
    if (meta.error) return null;
    if (Number(meta.pid) !== ownership.pid) return null;
    return {
      firstLine: String(meta.firstLine ?? ''),
      treeExcerpt: String(meta.treeExcerpt ?? '').slice(0, 2000),
    };
  } catch {
    return null;
  }
}

export async function captureOwnedWindow(
  ownership: ProcessOwnership,
  outPng: string,
): Promise<{ sha256: string; bytes: number }> {
  const script = resolveHelper('notepad-window-capture.ps1');
  if (!script) throw new Error('notepad-window-capture.ps1 missing');
  const r = await runPs(script, [
    '-TargetPid',
    String(ownership.pid),
    '-Hwnd',
    ownership.windowHandle,
    '-OutPath',
    outPng,
  ]);
  if (r.code !== 0 || !existsSync(outPng)) {
    throw new Error(`window_capture_failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  const { readFileSync, statSync } = await import('node:fs');
  const buf = readFileSync(outPng);
  return { sha256: sha256Hex(buf), bytes: statSync(outPng).size };
}

export function refuseForeignClose(
  ownership: ProcessOwnership | null,
  candidatePid: number,
): { refuse: true; reason: string } | { refuse: false } {
  if (!ownership) return { refuse: true, reason: 'no_owned_process' };
  if (candidatePid !== ownership.pid) {
    return { refuse: true, reason: 'pid_not_owned_by_mission' };
  }
  return { refuse: false };
}

export async function closeOwnedNotepad(ownership: ProcessOwnership): Promise<{
  closed: boolean;
  refused: boolean;
  reason: string;
}> {
  const check = refuseForeignClose(ownership, ownership.pid);
  if (check.refuse) {
    return { closed: false, refused: true, reason: check.reason };
  }
  // Prefer WM_CLOSE on owned HWND so shared Win11 Notepad process is not killed.
  const closeScript = resolveHelper('notepad-close-hwnd.ps1');
  if (closeScript && ownership.windowHandle) {
    const leaf = ownership.fixturePath
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') || '';
    const r = await runPs(closeScript, [
      '-TargetPid',
      String(ownership.pid),
      '-Hwnd',
      ownership.windowHandle,
      '-FixtureLeaf',
      leaf,
    ]);
    try {
      const meta = JSON.parse(r.stdout.trim() || '{}');
      if (meta.refused) {
        return { closed: false, refused: true, reason: String(meta.reason || 'close_refused') };
      }
      if (meta.closed || r.code === 0) {
        return {
          closed: Boolean(meta.closed),
          refused: false,
          reason: String(meta.reason || 'closed_owned_hwnd'),
        };
      }
    } catch {
      /* HWND close did not return JSON — continue to fail-closed path (no PID kill). */
    }
  }

  // Fail-closed: never kill a shared Win11 Notepad process by PID.
  // Only HWND/tab close is allowed; if the window is already gone, treat as cleaned.
  const script = resolveHelper('notepad-verify-pid.ps1');
  if (script) {
    const r = await runPs(script, ['-TargetPid', String(ownership.pid)]);
    if (r.code !== 0) {
      return { closed: true, refused: false, reason: 'process_already_gone' };
    }
  }
  return {
    closed: false,
    refused: true,
    reason: 'hwnd_close_failed_pid_kill_disabled_for_shared_notepad',
  };
}

export function assertWindowBelongsToOwnedProcess(
  ownership: ProcessOwnership,
  observedPid: number,
  observedTitle: string,
): void {
  if (observedPid !== ownership.pid) {
    throw new Error('window_belongs_to_other_process');
  }
  const title = (observedTitle || ownership.windowTitle || '').toLowerCase();
  const fixtureLeaf = ownership.fixturePath
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/, '')
    .toLowerCase();
  const looksLikeNotepad =
    title.includes('notepad') ||
    title.includes('блокнот') ||
    (fixtureLeaf != null && fixtureLeaf.length > 0 && title.includes(fixtureLeaf));
  if (!looksLikeNotepad) {
    throw new Error('wrong_window_title_redirect');
  }
}

/** Hash helper re-export for callers that only import this module. */
export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
