/**
 * control.ts — Atlas's general desktop hands.
 *
 * The v0 slice (notepad-control.ts) could read one hard-coded application. This is the
 * app-agnostic surface: enumerate what is on the machine, address real UI elements by
 * their UI Automation identity, act on them, and read the result back.
 *
 * Every function here is a thin typed wrapper over apps/desktop/atlas-desktop.ps1, which
 * owns the Win32/UIA work. The engine lives in PowerShell because UIAutomationClient is
 * a .NET assembly already present on every Windows host — no native npm module, no
 * node-gyp, nothing to install or keep building. That was the deciding factor over
 * nut.js/robotjs: this capability has to survive a fresh machine with zero setup.
 *
 * INVARIANTS the engine enforces and this layer must not paper over:
 *   - element addressing is by AutomationId / Name / ControlType, never by a raw point
 *     the caller supplies; `click` derives its point from the element's own rectangle
 *   - every window-scoped call re-checks the owning pid and refuses on mismatch
 *   - `launch` refuses a window that existed before the launch unless the caller named
 *     the expected title, so a tabbed app cannot hand back the user's own document
 *   - `close` refuses to kill a process that owns more than one visible window
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Bounds { x: number; y: number; w: number; h: number }

export interface WindowInfo {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  bounds: Bounds | null;
  minimized: boolean;
  foreground: boolean;
}

export interface ElementInfo {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  enabled: boolean;
  offscreen: boolean;
  bounds?: Bounds;
  patterns?: string[];
  level?: number;
}

export interface CaptureInfo { path: string; width: number; height: number; bytes: number }

export interface LaunchInfo {
  pid: number;
  startedPid: number;
  hwnd: number;
  title: string;
  process: string;
  focused: boolean;
  newWindow: boolean;
  reusedWindow: boolean;
}

export interface Selector {
  automationId?: string;
  name?: string;
  controlType?: string;
  index?: number;
}

/** Non-zero exits carry a stable machine-readable reason; keep it, do not stringify it away. */
export class DesktopError extends Error {
  constructor(
    readonly reason: string,
    readonly exitCode: number,
    readonly detail: Record<string, unknown>,
  ) {
    super(`desktop ${detail.action ?? '?'} failed: ${reason} (exit ${exitCode})`);
    this.name = 'DesktopError';
  }
}

function enginePath(): string {
  const rel = 'apps/desktop/atlas-desktop.ps1';
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), rel),
    resolve(here, '..', '..', '..', rel),
    resolve(here, '..', '..', '..', '..', rel),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`atlas-desktop.ps1 not found; looked in: ${candidates.join(', ')}`);
  return hit;
}

function flags(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    const name = `-${k[0].toUpperCase()}${k.slice(1)}`;
    if (v === true) out.push(name);
    else out.push(name, String(v));
  }
  return out;
}

async function run<T>(action: string, opts: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<T> {
  const script = enginePath();
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, '-Action', action, ...flags(opts)];

  return new Promise<T>((res, rej) => {
    const proc = spawn('powershell.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      rej(new Error(`desktop ${action}: powershell timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); rej(e); } });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The engine contracts to print exactly one JSON object on stdout. Other tooling on
      // this host (shell shims) prepends banner lines, so take the last JSON-looking line
      // rather than assuming stdout is pristine.
      const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}')).pop();
      if (!line) {
        rej(new Error(`desktop ${action}: no JSON on stdout (exit ${code}) ${stderr.slice(0, 300)}`));
        return;
      }
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line); } catch (e) {
        rej(new Error(`desktop ${action}: unparsable JSON: ${(e as Error).message}`));
        return;
      }
      if (code !== 0 || parsed.ok === false) {
        rej(new DesktopError(String(parsed.error ?? 'unknown'), code ?? -1, parsed));
        return;
      }
      res(parsed as T);
    });
  });
}

// ------------------------------------------------------------------ see

/** Every visible top-level window, optionally narrowed to one process. */
export async function listWindows(opts: { pid?: number; includeInvisible?: boolean } = {}): Promise<WindowInfo[]> {
  const r = await run<{ windows: WindowInfo[] }>('windows', {
    targetPid: opts.pid,
    includeInvisible: opts.includeInvisible,
  });
  return r.windows;
}

/** Monitor geometry plus whatever currently holds the foreground. */
export async function describeScreen(): Promise<{
  monitors: Array<{ name: string; primary: boolean; bounds: Bounds; working: Bounds }>;
  foreground: { hwnd: number; pid: number; process: string; title: string };
}> {
  return run('screen');
}

/** Screenshot the whole virtual desktop, or one window when `hwnd` is given. */
export async function capture(outFile: string, target?: { hwnd: number; pid: number }): Promise<CaptureInfo> {
  return run('capture', { outFile, hwnd: target?.hwnd, targetPid: target?.pid });
}

/** The UI Automation control tree of a window — how you discover what is addressable. */
export async function inspect(
  target: { hwnd: number; pid: number },
  opts: { depth?: number; maxNodes?: number } = {},
): Promise<{ window: ElementInfo; elements: ElementInfo[]; truncated: boolean }> {
  return run('tree', {
    hwnd: target.hwnd, targetPid: target.pid,
    depth: opts.depth, maxNodes: opts.maxNodes,
  });
}

/** Read text out of a window, or out of one element inside it. */
export async function readText(
  target: { hwnd: number; pid: number },
  sel: Selector = {},
): Promise<{ text: string; element: ElementInfo }> {
  return run('read', { hwnd: target.hwnd, targetPid: target.pid, ...sel });
}

// ------------------------------------------------------------------ act

/**
 * Start an application and bind to its window.
 *
 * `expectTitle` is not cosmetic. Tabbed applications answer a launch by adding a tab to
 * a window that is already open; without an expected title the engine refuses such a
 * window outright rather than handing back whatever the user had in front of them.
 */
export async function launch(
  path: string,
  opts: { args?: string; expectTitle?: string; timeoutMs?: number } = {},
): Promise<LaunchInfo> {
  return run('launch', {
    path, arguments: opts.args, name: opts.expectTitle, timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export async function focus(target: { hwnd: number; pid: number }): Promise<{ title: string }> {
  return run('focus', { hwnd: target.hwnd, targetPid: target.pid });
}

/** Set a control's value through ValuePattern; the engine reads it back and fails if it did not take. */
export async function setText(
  target: { hwnd: number; pid: number },
  sel: Selector,
  text: string,
): Promise<{ chars: number; verified: boolean }> {
  return run('settext', { hwnd: target.hwnd, targetPid: target.pid, ...sel, text });
}

/** Invoke / select / toggle an element, whichever pattern it actually supports. */
export async function invoke(target: { hwnd: number; pid: number }, sel: Selector): Promise<{ element: ElementInfo }> {
  return run('invoke', { hwnd: target.hwnd, targetPid: target.pid, ...sel });
}

/** Real mouse click, at a point derived from the element's own bounding rectangle. */
export async function click(
  target: { hwnd: number; pid: number },
  sel: Selector,
  opts: { button?: 'left' | 'right'; double?: boolean } = {},
): Promise<{ element: ElementInfo; point: { x: number; y: number }; button: string; presses: number }> {
  return run('click', {
    hwnd: target.hwnd, targetPid: target.pid, ...sel,
    button: opts.button, double: opts.double,
  });
}

/**
 * Move / resize / minimise / maximise / restore a window.
 *
 * `constrained: true` means the window applied the change but clamped it — an
 * application may enforce a minimum tracking size. That is the app's rule, not a
 * failure; only a window that did not move at all throws.
 */
export async function moveWindow(
  target: { hwnd: number; pid: number },
  to: Bounds | 'minimize' | 'maximize' | 'restore',
): Promise<{ before: Bounds | null; after: Bounds | null; minimized: boolean; constrained: boolean }> {
  const args = typeof to === 'string'
    ? { text: to }
    : { bounds: `${to.x},${to.y},${to.w},${to.h}` };
  return run('window', { hwnd: target.hwnd, targetPid: target.pid, ...args });
}

/** Mouse wheel over a chosen element. Negative notches scroll down. */
export async function scroll(
  target: { hwnd: number; pid: number },
  notches: number,
  sel: Selector = {},
): Promise<{ notches: number; element: ElementInfo }> {
  return run('scroll', { hwnd: target.hwnd, targetPid: target.pid, ...sel, index: notches });
}

/** Read the clipboard. Whatever the operator last copied — do not persist it. */
export async function readClipboard(): Promise<string> {
  const r = await run<{ text: string }>('clipboard');
  return r.text;
}

/** Write the clipboard and confirm it took. */
export async function writeClipboard(text: string): Promise<{ chars: number; verified: boolean }> {
  return run('clipboard', { text });
}

/** Literal typing (SendKeys grammar). For chords use {@link hotkey} — SendKeys drops modifiers. */
export async function typeText(target: { hwnd: number; pid: number }, keys: string): Promise<{ sent: number }> {
  return run('keys', { hwnd: target.hwnd, targetPid: target.pid, keys });
}

/** A key chord such as `ctrl+s`, pressed as real virtual keys so the active keyboard layout cannot break it. */
export async function hotkey(
  target: { hwnd: number; pid: number },
  chord: string,
): Promise<{ chord: string; titleAfter: string }> {
  return run('hotkey', { hwnd: target.hwnd, targetPid: target.pid, keys: chord });
}

/** Close a window. Refuses to kill a process that owns other visible windows. */
export async function close(target: { hwnd: number; pid: number }): Promise<{ closed: boolean; processAlive: boolean }> {
  return run('close', { hwnd: target.hwnd, targetPid: target.pid });
}

/** Wait until a window matching `predicate` appears, or throw. Polls the real window list. */
export async function waitForWindow(
  predicate: (w: WindowInfo) => boolean,
  timeoutMs = 15_000,
  pollMs = 400,
): Promise<WindowInfo> {
  const deadline = Date.now() + timeoutMs;
  let last: WindowInfo[] = [];
  while (Date.now() < deadline) {
    last = await listWindows();
    const hit = last.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForWindow: no match in ${timeoutMs}ms across ${last.length} windows`);
}
