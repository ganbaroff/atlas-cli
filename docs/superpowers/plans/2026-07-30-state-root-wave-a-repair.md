# State Root Wave A Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the additive `ATLAS_STATE_ROOT` resolver genuinely independent
of process CWD and correct its initial migration inventory without migrating
live call sites.

**Architecture:** Keep one pure resolver module. Environment overrides remain
backward-compatible only when they are stable absolute paths; relative or
Windows drive-relative values fail closed. Keep the registry explicitly
initial and additive, then correct the P2 mission record to match verified
source rather than rejected store totals.

**Tech Stack:** TypeScript, Node.js `path`/`os`, Vitest.

## Global Constraints

- No call-site migration, runtime-state copy, untrack, ignore edit, push,
  merge, scheduler change, Railway change, or physical move.
- Preserve legacy per-store override precedence.
- Never derive state location from process CWD.
- Missing/empty overrides use `<homedir>/.atlas/state`.
- Work only on the dedicated `codex/atlas-state-root-p2-wave-a-repair`
  branch.
- Preserve all unrelated dirty files.

---

### Task 1: Fail closed on unstable environment paths

**Files:**
- Modify: `src/atlas/state-root.ts`
- Modify: `src/__tests__/state-root.test.ts`

**Interfaces:**
- Consumes: `process.env.ATLAS_STATE_ROOT` and optional legacy per-store env
  variables.
- Produces: `resolveStateRoot(): string`,
  `resolveStateDir(store: StateStore, legacyEnv?: string): string`, and
  `StateRootConfigurationError`.

- [ ] **Step 1: Write failing relative-path tests**

Add native absolute fixtures and two failure cases:

```ts
import { tmpdir } from 'node:os';

const ABSOLUTE_STATE_ROOT = join(tmpdir(), 'atlas-state-root-test');
const ABSOLUTE_LEGACY_ROOT = join(tmpdir(), 'atlas-legacy-root-test');

it('rejects a relative ATLAS_STATE_ROOT', () => {
  process.env.ATLAS_STATE_ROOT = 'relative-state';
  expect(() => resolveStateRoot()).toThrow(
    'ATLAS_STATE_ROOT must be a stable absolute path'
  );
});

it('rejects a relative legacy store override', () => {
  process.env.ATLAS_EXEC_GRAPH_DIR = 'relative-exec-graph';
  expect(() => resolveStateDir('exec-graph')).toThrow(
    'ATLAS_EXEC_GRAPH_DIR must be a stable absolute path'
  );
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/__tests__/state-root.test.ts
```

Expected: the two new tests fail because relative values currently pass
through `path.resolve()`.

- [ ] **Step 3: Implement stable absolute override validation**

Use one helper for root and legacy overrides:

```ts
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, parse } from 'node:path';

export class StateRootConfigurationError extends Error {
  constructor(envName: string) {
    super(`${envName} must be a stable absolute path`);
    this.name = 'StateRootConfigurationError';
  }
}

function readAbsoluteOverride(envName: string): string | undefined {
  const value = process.env[envName]?.trim();
  if (!value) return undefined;

  const root = parse(value).root;
  const windowsRootIsStable =
    process.platform !== 'win32' ||
    /^[A-Za-z]:[\\/]$/.test(root) ||
    root.startsWith('\\\\');

  if (!isAbsolute(value) || !windowsRootIsStable) {
    throw new StateRootConfigurationError(envName);
  }

  return normalize(value);
}
```

`resolveStateRoot()` reads `ATLAS_STATE_ROOT` through the helper.
`resolveStateDir()` reads its selected legacy variable through the same helper.

- [ ] **Step 4: Replace POSIX-only fixtures and prove CWD invariance**

Replace `/tmp/...` test values with the native fixtures above. Add:

```ts
it('keeps an absolute override stable across cwd changes', () => {
  process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
  const before = resolveStateRoot();
  process.chdir(tmpdir());
  expect(resolveStateRoot()).toBe(before);
});
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
npx vitest run src/__tests__/state-root.test.ts
npx tsc --noEmit
```

Expected: all state-root tests pass; typecheck exits 0.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- src/atlas/state-root.ts src/__tests__/state-root.test.ts
git commit -m "fix(state): Reject unstable state root overrides"
```

---

### Task 2: Correct initial migration registry and mission record

**Files:**
- Modify: `src/atlas/state-root.ts`
- Modify: `src/__tests__/state-root.test.ts`
- Modify: `docs/atlas-cto/P2-MISSION-2026-07-29.md`

**Interfaces:**
- Consumes: verified checkout-relative paths in
  `src/swarm-exec/intake.ts` and `src/atlas/task-spawner.ts`.
- Produces: an explicitly initial `STATE_STORES` registry that includes
  `intake-drafts` and `task-results`; corrected provisional mission record.

- [ ] **Step 1: Write failing registry test**

```ts
it('includes known initial migration stores without claiming completeness', () => {
  expect(Object.keys(STATE_STORES)).toEqual(
    expect.arrayContaining([
      'exec-graph',
      'evidence',
      'goal-budgets',
      'swarm-runs',
      'operator-state',
      'operator-runs',
      'intake-drafts',
      'task-results',
    ])
  );
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```powershell
npx vitest run src/__tests__/state-root.test.ts
```

Expected: failure because `intake-drafts` and `task-results` are absent.

- [ ] **Step 3: Extend and relabel the registry**

Add:

```ts
'intake-drafts': undefined,
'task-results': undefined,
```

Change its comment to:

```ts
/** Initial migration registry; not a claim of complete runtime-store inventory. */
```

Rename the old exact-six registry test so it no longer claims completeness.

- [ ] **Step 4: Correct the P2 mission record**

Replace rejected `~25 / 21 / six` totals with verified statements:

- resolution was scattered and `ATLAS_STATE_ROOT` was absent;
- the initial registry covers eight known migration candidates;
- `state/intake-drafts` and legacy hardcoded task results were omitted from the
  first inventory;
- exactly three Git entries exist under `state/exec-graph`, but only
  `graph.json` and `ledger.jsonl` are generated runtime state;
- Wave A remains additive and provisional;
- Codex is present and independently verified the repair.

- [ ] **Step 5: Run final evidence commands**

Run:

```powershell
npx vitest run src/__tests__/state-root.test.ts
npx tsc --noEmit
git diff --check
git diff --name-only
```

Expected: tests pass, typecheck exits 0, diff check is clean, and only the
three owned files are changed relative to the branch checkpoint.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- src/atlas/state-root.ts src/__tests__/state-root.test.ts docs/atlas-cto/P2-MISSION-2026-07-29.md
git commit -m "docs(state): Correct initial state store inventory"
```

---

## Completion Evidence

Before closure, Codex must independently show:

```powershell
npx vitest run src/__tests__/state-root.test.ts
npx tsc --noEmit
git log -3 --oneline
git status --short --branch
```

No live state, generated graph file, provider, scheduler, deployment, remote,
or physical path is mutated by this plan.
