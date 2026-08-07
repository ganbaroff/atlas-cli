/**
 * Wave 6 acceptance: PANIC terminates the whole mission process tree, and
 * nothing else.
 *
 * These tests spawn REAL processes — a grandchild chain and one unrelated
 * bystander — because the property under test is exactly the thing a mock
 * cannot show: that `taskkill /T /F` on this host reaches descendants, and that
 * a process outside the mission survives it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  collectDescendants,
  isAlive,
  JOB_OBJECTS_AVAILABLE,
  killProcessTree,
  listChildPids,
  MissionProcessRegistry,
  type CommandRunner,
} from '../atlas/executor/process-tree.js';

const IS_WINDOWS = process.platform === 'win32';

/** A node process that idles until killed. */
function spawnIdler(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** A node process that spawns its own idling child, then idles. */
function spawnParentWithChild(): ChildProcess {
  return spawn(
    process.execPath,
    [
      '-e',
      "const {spawn}=require('node:child_process');" +
        "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
        'setInterval(()=>{},1000);',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('job objects', () => {
  it('are documented unavailable on this host rather than silently assumed', () => {
    // AssignProcessToJobObject: (50) The request is not supported.
    expect(JOB_OBJECTS_AVAILABLE).toBe(false);
  });
});

describe('isAlive', () => {
  it('reports the current process alive and an impossible pid dead', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 30)).toBe(false);
  });
});

describe('listChildPids / collectDescendants', () => {
  it('parses pids from the runner and ignores noise', () => {
    const run: CommandRunner = () => ({ stdout: '1234\r\n5678\r\n\r\nnot-a-pid\r\n', status: 0 });
    expect(listChildPids(1, run)).toEqual([1234, 5678]);
  });

  it('returns nothing when the query fails rather than guessing', () => {
    const run: CommandRunner = () => ({ stdout: 'access denied', status: 1 });
    expect(listChildPids(1, run)).toEqual([]);
  });

  it('walks a chain depth-first without revisiting a cycle', () => {
    const tree: Record<number, number[]> = { 10: [20], 20: [30], 30: [10] };
    const run: CommandRunner = (_bin, args) => {
      const parent = Number(/ParentProcessId=(\d+)/.exec(String(args[3]))?.[1] ?? 0);
      return { stdout: (tree[parent] ?? []).join('\n'), status: 0 };
    };
    expect(collectDescendants(10, run).sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });

  it('stops at the depth bound so a pathological chain cannot hang PANIC', () => {
    const run: CommandRunner = (_bin, args) => {
      const parent = Number(/ParentProcessId=(\d+)/.exec(String(args[3]))?.[1] ?? 0);
      return { stdout: String(parent + 1), status: 0 };
    };
    expect(collectDescendants(1, run, 3).length).toBeLessThanOrEqual(4);
  });
});

describe('MissionProcessRegistry', () => {
  it('refuses a dead pid, so a recycled number cannot become a PANIC target', () => {
    const registry = new MissionProcessRegistry(() => false);
    expect(registry.register(4321)).toBe(false);
    expect(registry.registered).toEqual([]);
  });

  it('refuses a nonsense pid', () => {
    const registry = new MissionProcessRegistry(() => true);
    expect(registry.register(0)).toBe(false);
    expect(registry.register(-1)).toBe(false);
    expect(registry.register(1.5)).toBe(false);
  });

  it('records a live pid once', () => {
    const registry = new MissionProcessRegistry(() => true);
    registry.register(111);
    registry.register(111);
    expect(registry.registered).toEqual([111]);
  });
});

describe('killProcessTree — real processes', () => {
  it('kills a single mission process', async () => {
    const child = spawnIdler();
    await sleep(300);
    expect(isAlive(child.pid as number)).toBe(true);

    const result = killProcessTree(child.pid as number);
    await sleep(500);

    expect(result.ok).toBe(true);
    expect(result.survivors).toEqual([]);
    expect(isAlive(child.pid as number)).toBe(false);
  }, 30_000);

  it.runIf(IS_WINDOWS)('kills a grandchild the mission spawned indirectly', async () => {
    const parent = spawnParentWithChild();
    await sleep(1200);
    const parentPid = parent.pid as number;
    const descendants = collectDescendants(parentPid);

    // The proof is only meaningful if a descendant actually existed.
    expect(descendants.length).toBeGreaterThan(0);
    const grandchild = descendants[0] as number;
    expect(isAlive(grandchild)).toBe(true);

    const result = killProcessTree(parentPid);
    await sleep(900);

    expect(result.method).toBe('taskkill-tree');
    expect(isAlive(parentPid)).toBe(false);
    expect(isAlive(grandchild)).toBe(false);
    expect(result.survivors).toEqual([]);
  }, 45_000);

  it('leaves an unrelated process untouched', async () => {
    const mission = spawnIdler();
    const bystander = spawnIdler();
    await sleep(400);

    killProcessTree(mission.pid as number);
    await sleep(600);

    expect(isAlive(mission.pid as number)).toBe(false);
    expect(isAlive(bystander.pid as number)).toBe(true);

    bystander.kill('SIGKILL');
  }, 30_000);

  it('reports an already-exited target as alreadyExited, not as a survivor', async () => {
    const child = spawnIdler();
    await sleep(300);
    const pid = child.pid as number;
    child.kill('SIGKILL');
    await sleep(500);

    const result = killProcessTree(pid);
    expect(result.ok).toBe(true);
    expect(result.alreadyExited).toContain(pid);
    expect(result.survivors).toEqual([]);
  }, 30_000);

  it('reports PANIC INCOMPLETE when a target survives, instead of claiming success', () => {
    const run: CommandRunner = () => ({ stdout: '', status: 0 });
    const result = killProcessTree(999_001, { run, alive: () => true });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('PANIC INCOMPLETE');
    expect(result.survivors).toContain(999_001);
  });
});
