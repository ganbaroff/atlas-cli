/**
 * Contract tests for the general desktop hands.
 *
 * These do NOT drive the desktop — a suite that needs a logged-in interactive session
 * with a particular app installed is a suite that gets skipped and then rots. The live
 * end-to-end proof lives in scripts/desktop-control-proof.mts and is run deliberately.
 *
 * What is pinned here is the part that silently degrades: the safety invariants. Every
 * one of them below was added because it failed for real on 2026-08-08, and each is a
 * single line away from being deleted by someone "simplifying" the engine.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENGINE = resolve(process.cwd(), 'apps/desktop/atlas-desktop.ps1');
const engine = (): string => readFileSync(ENGINE, 'utf8');

describe('desktop control engine', () => {
  it('ships the engine script next to the typed wrapper', () => {
    expect(existsSync(ENGINE)).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'src/atlas/desktop/control.ts'))).toBe(true);
  });

  it('exposes the full see/act surface', () => {
    const src = engine();
    for (const action of [
      'windows', 'screen', 'capture', 'tree', 'read',
      'launch', 'focus', 'settext', 'invoke', 'click', 'keys', 'hotkey', 'close',
      'window', 'scroll', 'clipboard',
    ]) {
      expect(src, `action ${action} missing`).toContain(`'${action}' {`);
    }
  });

  it('becomes DPI aware before it reads any coordinate', () => {
    const src = engine();
    expect(src).toContain('SetProcessDPIAware');
    // Must happen before the action switch, or `capture` silently saves a cropped
    // top-left region of a scaled display and reports it as the whole screen.
    expect(src.indexOf('[void][AtlasDesk]::SetProcessDPIAware()')).toBeLessThan(src.indexOf('switch ($Action'));
  });

  it('verifies the owning process id on window-scoped actions', () => {
    const src = engine();
    expect(src).toContain('window_pid_mismatch');
    expect(src).toContain('function Assert-WindowPid');
    // Every window-scoped action must call it; a new action that forgets is the bug.
    const actionBlocks = src.split(/^\s{2}'(?=[a-z]+' \{)/m).slice(1);
    const windowScoped = actionBlocks.filter((b) => /Resolve-Hwnd \$Hwnd/.test(b));
    expect(windowScoped.length).toBeGreaterThanOrEqual(8);
    for (const block of windowScoped) {
      expect(block, `block without pid assertion: ${block.slice(0, 40)}`).toMatch(/Assert-WindowPid/);
    }
  });

  it('refuses a window that existed before the launch unless the caller named its title', () => {
    const src = engine();
    expect(src).toContain('no_new_window_after_launch');
    expect(src).toContain('pre_existing_window');
    // Windows 11 Notepad answers a launch with a new TAB in the user's existing window.
    // Binding to it and typing edits whatever document they had open.
    expect(src).toMatch(/if \(-not \$isNew -and -not \$matchName\)/);
  });

  it('refuses to kill a process that owns more than one visible window', () => {
    const src = engine();
    expect(src).toContain('close_would_kill_shared_process');
    // Store apps share one ApplicationFrameHost pid, so Stop-Process as a close
    // fallback takes down unrelated windows the caller never named.
    expect(src.indexOf('close_would_kill_shared_process')).toBeLessThan(src.lastIndexOf('Stop-Process'));
  });

  it('has no action that clicks at a caller-supplied coordinate', () => {
    const src = engine();
    // The click point is derived from the element's own BoundingRectangle. A raw
    // point cannot be verified and lands wherever the desktop happens to be.
    expect(src).toMatch(/\$cx = \[int\]\(\$r\.X \+ \$r\.Width \/ 2\)/);
    expect(src).not.toMatch(/-X\b.*-Y\b/);
  });

  it('maps latin keys by virtual-key code so the keyboard layout cannot break chords', () => {
    const src = engine();
    // VkKeyScan asks the ACTIVE layout and returns -1 for 's' under a Russian layout,
    // which made ctrl+s unreachable. Accelerators are defined by VK code, not glyph.
    expect(src).toMatch(/0x41 \+ \(\[int\]\[char\]\$ch - \[int\]\[char\]'a'\)/);
  });

  it('retries focus instead of reporting failure on the first miss', () => {
    const src = engine();
    expect(src).toMatch(/for \(\$attempt = 1; \$attempt -le \d+; \$attempt\+\+\)/);
    // ...but still only returns true on an observed foreground change.
    expect(src).toMatch(/return \(\[AtlasDesk\]::GetForegroundWindow\(\) -eq \$h\)/);
  });

  it('never sends keystrokes to a window it could not focus', () => {
    const src = engine();
    const keysBlock = src.slice(src.indexOf("'keys' {"), src.indexOf("'hotkey' {"));
    expect(keysBlock).toMatch(/if \(-not \(Focus-Window \$h\)\) \{ Fail 'focus_not_confirmed'/);
    expect(keysBlock.indexOf('focus_not_confirmed')).toBeLessThan(keysBlock.indexOf('SendKeys'));
  });

  it('distinguishes a window the app constrained from one that never moved', () => {
    const src = engine();
    // Calculator honours a requested position and width but clamps height to its own
    // minimum. Throwing there would make `window` unusable on any app with a minimum;
    // reporting success on a window that did not move would be a lie. Both cases exist.
    expect(src).toContain('window_geometry_unchanged');
    expect(src).toMatch(/if \(\$off -and -not \$moved\)/);
    expect(src).toMatch(/constrained = \$off/);
  });

  it('reinterprets negative wheel deltas instead of casting them', () => {
    const src = engine();
    // [uint32](-360) throws in PowerShell, so scrolling down died silently before
    // reaching Emit and the caller saw an empty stdout rather than an error.
    expect(src).toContain('[System.BitConverter]::ToUInt32');
    expect(src).not.toMatch(/\[uint32\]\(\[int\]\(\$notches \* 120\)\)/);
  });

  it('verifies the clipboard write it claims to have made', () => {
    const src = engine();
    expect(src).toContain('clipboard_verify_failed');
    const block = src.slice(src.indexOf("'clipboard' {"), src.indexOf("'hotkey' {"));
    expect(block.indexOf('Set-Clipboard')).toBeLessThan(block.indexOf('clipboard_verify_failed'));
  });

  it('emits exactly one JSON object and a stable exit code per action', () => {
    const src = engine();
    expect(src).toMatch(/ConvertTo-Json -Compress -Depth 12/);
    for (const [reason, code] of [
      ['window_pid_mismatch', 3], ['uia_from_handle_null', 4],
      ['element_not_found', 5], ['pattern_not_supported', 6],
    ] as const) {
      expect(src, `${reason} should exit ${code}`).toMatch(new RegExp(`'${reason}' ${code}`));
    }
  });
});
