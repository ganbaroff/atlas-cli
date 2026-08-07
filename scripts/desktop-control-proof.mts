/**
 * desktop-control-proof.mts — end-to-end acceptance for Atlas's desktop hands.
 *
 * Drives a real application through src/atlas/desktop/control.ts and checks each step
 * against ground truth the application itself reports, not against our own narration.
 * Calculator is the target on purpose: it holds no user data, its buttons carry stable
 * AutomationIds, and its display is an independent readout of whether the clicks landed.
 *
 *   npx tsx scripts/desktop-control-proof.mts
 *
 * Writes a receipt to .atlas-proof/desktop-control-receipt.json and exits non-zero on
 * the first failed check.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  capture, click, close, describeScreen, focus, inspect, invoke,
  launch, listWindows, readText,
} from '../src/atlas/desktop/control.js';

const OUT = resolve(process.cwd(), '.atlas-proof');
mkdirSync(OUT, { recursive: true });

interface Check { id: string; what: string; expected: string; actual: string; pass: boolean }
const checks: Check[] = [];
let failed = 0;

function gate(id: string, what: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, what, expected, actual, pass });
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${what}\n        expected ${expected}\n        actual   ${actual}`);
}

async function main(): Promise<void> {
  // ---- SEE ---------------------------------------------------------------
  const screen = await describeScreen();
  const primary = screen.monitors.find((m) => m.primary) ?? screen.monitors[0];
  gate('S1', 'enumerates physical monitor geometry',
    'a primary monitor at least 800px wide',
    `${primary.bounds.w}x${primary.bounds.h}`,
    primary.bounds.w >= 800 && primary.bounds.h >= 600);

  const windows = await listWindows();
  gate('S2', 'enumerates live top-level windows',
    'at least 3 titled windows with pids',
    `${windows.length} windows, e.g. ${windows.slice(0, 3).map((w) => w.process).join('/')}`,
    windows.length >= 3 && windows.every((w) => w.pid > 0));

  const shot = await capture(resolve(OUT, 'proof-desktop.png'));
  gate('S3', 'captures the full desktop at physical resolution',
    `${primary.bounds.w}x${primary.bounds.h} png, non-trivial size`,
    `${shot.width}x${shot.height}, ${shot.bytes}b`,
    shot.width >= primary.bounds.w && shot.height >= primary.bounds.h && shot.bytes > 10_000);

  // ---- ACT ---------------------------------------------------------------
  const app = await launch('calc.exe', { expectTitle: 'Calculator', timeoutMs: 25_000 });
  const target = { hwnd: app.hwnd, pid: app.pid };
  gate('A1', 'launches an application and binds a real window',
    'a window titled Calculator, owned by a live pid',
    `pid ${app.pid} hwnd ${app.hwnd} "${app.title}" newWindow=${app.newWindow}`,
    /calculator/i.test(app.title) && app.pid > 0 && app.hwnd > 0);

  await focus(target);
  const fg = await describeScreen();
  gate('A2', 'brings the target window to the foreground',
    `foreground hwnd ${app.hwnd}`,
    `foreground hwnd ${fg.foreground.hwnd} ("${fg.foreground.title}")`,
    fg.foreground.hwnd === app.hwnd);

  const tree = await inspect(target, { depth: 6, maxNodes: 300 });
  const ids = new Set(tree.elements.map((e) => e.automationId).filter(Boolean));
  gate('A3', 'reads the UI Automation tree and finds addressable controls',
    'num9Button, multiplyButton, equalButton, CalculatorResults all present',
    `${tree.elements.length} elements; missing: ${['num9Button', 'multiplyButton', 'equalButton', 'CalculatorResults'].filter((k) => !ids.has(k)).join(',') || 'none'}`,
    ['num9Button', 'multiplyButton', 'equalButton', 'CalculatorResults'].every((k) => ids.has(k)));

  // Clear first: this Calculator may hold state from an earlier run, and a proof that
  // depends on the app starting empty is a proof that passes for the wrong reason.
  await invoke(target, { automationId: 'clearButton' });
  const zero = await readText(target, { automationId: 'CalculatorResults' });
  gate('A4', 'resets application state before measuring',
    'display reads 0',
    zero.text,
    /(^|\D)0\s*$/.test(zero.text));

  // Mouse path: a real cursor press at a point derived from the element's own rectangle.
  const c1 = await click(target, { automationId: 'num9Button' });
  gate('A5', 'clicks a control with the real mouse',
    'cursor pressed inside the num9Button rectangle',
    `point (${c1.point.x},${c1.point.y}) in ${JSON.stringify(c1.element.bounds)}`,
    !!c1.element.bounds
      && c1.point.x >= c1.element.bounds.x && c1.point.x <= c1.element.bounds.x + c1.element.bounds.w
      && c1.point.y >= c1.element.bounds.y && c1.point.y <= c1.element.bounds.y + c1.element.bounds.h);

  // UIA pattern path: same outcome, different mechanism, so one failing does not hide the other.
  await invoke(target, { automationId: 'multiplyButton' });
  await click(target, { automationId: 'num8Button' });
  await invoke(target, { automationId: 'equalButton' });

  const result = await readText(target, { automationId: 'CalculatorResults' });
  gate('A6', 'the application itself confirms the actions landed',
    '9 x 8 = 72 shown on the calculator display',
    result.text,
    /(^|\D)72\s*$/.test(result.text));

  const winShot = await capture(resolve(OUT, 'proof-calculator.png'), target);
  gate('A7', 'captures a single window rather than the whole screen',
    'png smaller than the desktop capture',
    `${winShot.width}x${winShot.height}, ${winShot.bytes}b`,
    winShot.width > 0 && winShot.width < shot.width && winShot.bytes > 1000);

  // ---- CLEAN UP ----------------------------------------------------------
  await close(target);
  const after = await listWindows();
  gate('A8', 'closes the window it opened',
    `hwnd ${app.hwnd} no longer listed`,
    `${after.filter((w) => w.hwnd === app.hwnd).length} matching windows remain`,
    !after.some((w) => w.hwnd === app.hwnd));

  // ---- SAFETY ------------------------------------------------------------
  // The refusals matter as much as the actions: hands that cannot say no are not safe
  // to leave running unattended.
  let refusedWrongPid = false;
  const bystander = after.find((w) => w.pid > 0);
  if (bystander) {
    try {
      await readText({ hwnd: bystander.hwnd, pid: bystander.pid + 999_999 });
    } catch (e) {
      refusedWrongPid = /window_pid_mismatch/.test(String(e));
    }
  }
  gate('G1', 'refuses to act on a window whose pid does not match the caller',
    'window_pid_mismatch',
    refusedWrongPid ? 'window_pid_mismatch' : 'no refusal',
    refusedWrongPid);

  let refusedNoSelector = false;
  try {
    await invoke({ hwnd: windows[0].hwnd, pid: windows[0].pid }, {});
  } catch (e) {
    refusedNoSelector = /selector_required/.test(String(e));
  }
  gate('G2', 'refuses to act without an element selector',
    'selector_required',
    refusedNoSelector ? 'selector_required' : 'no refusal',
    refusedNoSelector);

  const receipt = {
    generatedAt: new Date().toISOString(),
    host: { monitors: screen.monitors, windowCount: windows.length },
    checks,
    passed: checks.length - failed,
    total: checks.length,
    artifacts: [resolve(OUT, 'proof-desktop.png'), resolve(OUT, 'proof-calculator.png')],
  };
  writeFileSync(resolve(OUT, 'desktop-control-receipt.json'), JSON.stringify(receipt, null, 2));

  console.log(`\n${receipt.passed}/${receipt.total} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('proof aborted:', e?.message ?? e);
  process.exit(1);
});
