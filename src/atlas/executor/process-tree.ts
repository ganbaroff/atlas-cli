/**
 * atlas/executor/process-tree.ts — Atlas-owned termination of a mission's
 * process tree.
 *
 * Job objects are the textbook answer on Windows and are NOT available on this
 * host: creating one fails with `AssignProcessToJobObject: (50) The request is
 * not supported`. PANIC semantics do not bend to accommodate that, so the tree
 * is walked and killed explicitly instead.
 *
 * The safety property is negative and load-bearing: only processes Atlas can
 * prove belong to the mission are killed. Ownership comes from the recorded
 * root pid and the live parent-child chain — never from a name match, because
 * "kill every node.exe" would take down the caller and any unrelated editor.
 */

import { spawnSync } from 'node:child_process';

export interface ProcessTreeKillResult {
  readonly rootPid: number;
  /** Every pid Atlas proved was a descendant, root included. */
  readonly killedPids: readonly number[];
  /** Pids that were already gone when the kill ran. Not an error. */
  readonly alreadyExited: readonly number[];
  /** Pids Atlas failed to kill — a non-empty list means PANIC did not fully succeed. */
  readonly survivors: readonly number[];
  readonly method: 'taskkill-tree' | 'posix-signal';
  readonly ok: boolean;
  readonly detail: string;
}

export type CommandRunner = (bin: string, args: readonly string[]) => { stdout: string; status: number };

const realRunner: CommandRunner = (bin, args) => {
  const res = spawnSync(bin, [...args], { encoding: 'utf8', windowsHide: true });
  return { stdout: `${res.stdout ?? ''}${res.stderr ?? ''}`, status: res.status ?? 1 };
};

/**
 * Lists direct children of a pid on Windows. Uses CIM rather than the
 * deprecated `wmic`, which is absent on current Windows builds.
 */
export function listChildPids(parentPid: number, run: CommandRunner = realRunner): number[] {
  const { stdout, status } = run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Select-Object -ExpandProperty ProcessId`,
  ]);
  if (status !== 0) return [];
  return stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Depth-first descendant walk. Bounded so a pid cycle cannot hang PANIC. */
export function collectDescendants(rootPid: number, run: CommandRunner = realRunner, maxDepth = 8): number[] {
  const seen = new Set<number>();
  const walk = (pid: number, depth: number): void => {
    if (depth > maxDepth) return;
    for (const child of listChildPids(pid, run)) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child, depth + 1);
    }
  };
  walk(rootPid, 0);
  return [...seen];
}

export function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Kills a mission's process tree.
 *
 * On Windows `taskkill /T /F` terminates the pid and its descendants in one
 * call; the descendant list is still collected first so the receipt can name
 * exactly what PANIC was responsible for, and so survivors can be detected
 * afterwards rather than assumed absent.
 */
export function killProcessTree(
  rootPid: number,
  options: { readonly run?: CommandRunner; readonly alive?: (pid: number) => boolean } = {},
): ProcessTreeKillResult {
  const run = options.run ?? realRunner;
  const alive = options.alive ?? isAlive;
  const isWindows = process.platform === 'win32';

  const descendants = isWindows ? collectDescendants(rootPid, run) : [];
  const targets = [rootPid, ...descendants];
  const alreadyExited = targets.filter((pid) => !alive(pid));

  if (isWindows) {
    run('taskkill', ['/T', '/F', '/PID', String(rootPid)]);
  } else {
    for (const pid of targets) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  const survivors = targets.filter((pid) => alive(pid));
  const killed = targets.filter((pid) => !survivors.includes(pid) && !alreadyExited.includes(pid));

  return {
    rootPid,
    killedPids: killed,
    alreadyExited,
    survivors,
    method: isWindows ? 'taskkill-tree' : 'posix-signal',
    ok: survivors.length === 0,
    detail:
      survivors.length === 0
        ? `terminated ${killed.length} mission-owned process(es); ${alreadyExited.length} had already exited`
        : `PANIC INCOMPLETE — ${survivors.length} mission process(es) survived: ${survivors.join(', ')}`,
  };
}

/**
 * Records which pids a mission spawned so PANIC has a proven root rather than a
 * guess. A pid is only accepted while it is alive: a recycled pid recorded
 * after the fact could point at an unrelated process.
 */
export class MissionProcessRegistry {
  private readonly pids = new Set<number>();

  constructor(private readonly alive: (pid: number) => boolean = isAlive) {}

  register(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (!this.alive(pid)) return false;
    this.pids.add(pid);
    return true;
  }

  get registered(): readonly number[] {
    return [...this.pids];
  }

  /** Kills every registered root. Unregistered processes are never touched. */
  killAll(options?: { run?: CommandRunner; alive?: (pid: number) => boolean }): ProcessTreeKillResult[] {
    return this.registered.map((pid) => killProcessTree(pid, options));
  }
}

/**
 * Job objects are unavailable on this host — creating one fails with
 * `AssignProcessToJobObject: (50) The request is not supported`. Kept as a
 * named constant so the reason is discoverable at the call site rather than
 * buried in a commit message, and so a future host that supports them is a
 * one-line change plus a fresh proof.
 */
export const JOB_OBJECTS_AVAILABLE = false;
