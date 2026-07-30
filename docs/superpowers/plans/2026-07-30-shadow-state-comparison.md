# M3A Shadow State Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict, read-only comparator that proves whether two explicit
exec-graph directories contain the same ledger bytes and semantic graph state.

**Architecture:** New `shadow-state.ts` reads only paths passed by the caller;
it never consults environment variables or a live resolver. Each directory is
validated independently: both files must be regular files, every non-empty
ledger line must pass `ledgerEventSchema`, the snapshot must pass
`graphSnapshotFileSchema`, and the snapshot must equal a fresh fold of the
ledger. Comparison then reports hashes, counts, and exact parity without
writing, copying, deleting, or switching state.

**Tech Stack:** TypeScript, Node `fs`/`crypto`/`path`, Zod schemas already in
`src/exec-graph/contracts.ts`, Vitest.

## Global Constraints

- No live state mutation, copy, delete, resolver switch, scheduler change,
  network call, provider call, push, merge, deployment, or physical move.
- Source and candidate directories are explicit function arguments.
- Any malformed ledger line fails closed; do not reuse the normal
  availability-oriented reader that skips malformed rows.
- Preserve all unrelated dirty files.
- M3A reports evidence only. M3B owns synthetic copying; M3C owns a rehearsal
  against a separately preserved state copy.

---

### Task 1: Strict explicit-directory inspection

**Files:**

- Create: `src/atlas/shadow-state.ts`
- Create: `src/__tests__/shadow-state.test.ts`

**Interfaces:**

- Consumes: `ledgerEventSchema`, `graphSnapshotFileSchema`, `foldEvents`,
  `snapshotsEqual`.
- Produces:

```ts
export type ShadowStateErrorCode =
  | 'directory_missing'
  | 'ledger_not_regular'
  | 'snapshot_not_regular'
  | 'ledger_invalid'
  | 'snapshot_invalid'
  | 'snapshot_diverged';

export class ShadowStateError extends Error {
  constructor(readonly code: ShadowStateErrorCode, message: string);
}

export interface ExecGraphInspection {
  readonly directory: string;
  readonly ledgerSha256: string;
  readonly snapshotSha256: string;
  readonly semanticSha256: string;
  readonly eventCount: number;
  readonly goalCount: number;
  readonly taskCount: number;
}

export function inspectExecGraphDirectory(directory: string): ExecGraphInspection;
```

- [ ] **Step 1: Write failing tests for valid inspection and fail-closed input**

Create temp directories in `beforeEach`, remove only those exact temp
directories in `afterEach`, and add these assertions:

```ts
it('strictly inspects a valid explicit exec-graph directory', () => {
  const dir = writeValidGraphFixture('source');
  const result = inspectExecGraphDirectory(dir);

  expect(result.directory).toBe(resolve(dir));
  expect(result.eventCount).toBe(2);
  expect(result.goalCount).toBe(1);
  expect(result.taskCount).toBe(1);
  expect(result.ledgerSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.semanticSha256).toMatch(/^[a-f0-9]{64}$/);
});

it('rejects one malformed ledger line instead of skipping it', () => {
  const dir = writeValidGraphFixture('bad-ledger');
  appendFileSync(join(dir, 'ledger.jsonl'), '{not-json}\n', 'utf8');

  expect(() => inspectExecGraphDirectory(dir)).toThrow(
    expect.objectContaining({ code: 'ledger_invalid' }),
  );
});

it('rejects a valid snapshot that diverges from its ledger fold', () => {
  const dir = writeValidGraphFixture('diverged');
  writeFileSync(join(dir, 'graph.json'), '{"goals":[],"tasks":[]}\n', 'utf8');

  expect(() => inspectExecGraphDirectory(dir)).toThrow(
    expect.objectContaining({ code: 'snapshot_diverged' }),
  );
});
```

The fixture must build schema-valid `goal-created` and `task-created` events,
write them as JSONL, call `foldEvents(events)`, and write the corresponding
array-shaped `graph.json`.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npx vitest run src/__tests__/shadow-state.test.ts
```

Expected: FAIL because `../atlas/shadow-state.js` does not exist.

- [ ] **Step 3: Implement the strict inspector**

Implementation rules:

1. `resolve(directory)` once and use only that explicit path.
2. Require the directory and both `ledger.jsonl`/`graph.json` to be regular
   files via `lstatSync`; symlinks/junction-backed files do not satisfy this
   proof.
3. Hash exact UTF-8 file bytes with SHA-256.
4. Parse every non-empty ledger line with `JSON.parse` followed by
   `ledgerEventSchema.safeParse`; include the 1-based line number in failures.
5. Parse `graph.json` with `graphSnapshotFileSchema.safeParse`.
6. Convert snapshot arrays to id-keyed maps, fold ledger events with
   `foldEvents`, and require `snapshotsEqual`.
7. Canonical semantic hash is SHA-256 over JSON containing goals and tasks
   sorted by id.
8. Throw only `ShadowStateError` with one of the declared codes.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
npx vitest run src/__tests__/shadow-state.test.ts
```

Expected: all Task 1 tests pass.

### Task 2: Pair comparison receipt

**Files:**

- Modify: `src/atlas/shadow-state.ts`
- Modify: `src/__tests__/shadow-state.test.ts`

**Interfaces:**

- Consumes: `inspectExecGraphDirectory(directory)`.
- Produces:

```ts
export interface ShadowStateComparison {
  readonly source: ExecGraphInspection;
  readonly candidate: ExecGraphInspection;
  readonly ledgerBytesEqual: boolean;
  readonly snapshotBytesEqual: boolean;
  readonly semanticStateEqual: boolean;
  readonly countsEqual: boolean;
  readonly accepted: boolean;
  readonly blocker: string | 'not-applicable';
  readonly nextAction: string;
  readonly liveResolverChanged: false;
}

export function compareExecGraphDirectories(
  sourceDirectory: string,
  candidateDirectory: string,
): ShadowStateComparison;
```

- [ ] **Step 1: Write failing parity and mismatch tests**

```ts
it('accepts byte-identical ledger and semantically identical state', () => {
  const source = writeValidGraphFixture('source');
  const candidate = writeValidGraphFixture('candidate');

  expect(compareExecGraphDirectories(source, candidate)).toMatchObject({
    ledgerBytesEqual: true,
    snapshotBytesEqual: true,
    semanticStateEqual: true,
    countsEqual: true,
    accepted: true,
    blocker: 'not-applicable',
    liveResolverChanged: false,
  });
});

it('refuses a candidate whose valid ledger represents different state', () => {
  const source = writeValidGraphFixture('source');
  const candidate = writeDifferentValidGraphFixture('candidate');

  expect(compareExecGraphDirectories(source, candidate)).toMatchObject({
    accepted: false,
    semanticStateEqual: false,
    liveResolverChanged: false,
  });
});
```

- [ ] **Step 2: Run the named tests and verify RED**

Run:

```powershell
npx vitest run src/__tests__/shadow-state.test.ts -t "accepts|refuses"
```

Expected: FAIL because `compareExecGraphDirectories` is absent.

- [ ] **Step 3: Implement minimal comparison**

Call the strict inspector once per side. `accepted` requires ledger byte hash,
semantic hash, event count, goal count, and task count to match. Snapshot byte
hash is reported but is not an acceptance requirement because stable semantic
state may have harmless JSON formatting or array-order differences.

On acceptance:

```ts
{
  blocker: 'not-applicable',
  nextAction: 'proceed to an isolated synthetic copy/replay proof; do not switch the live resolver',
  liveResolverChanged: false,
}
```

On mismatch, `blocker` names each failed predicate and `nextAction` is:

```text
repair the isolated candidate and rerun comparison; do not activate it
```

- [ ] **Step 4: Verify focused suite, typecheck, and diff**

Run:

```powershell
npx vitest run src/__tests__/shadow-state.test.ts
npx tsc --noEmit
git diff --check
```

Expected: all shadow-state tests pass; TypeScript and diff checks exit 0.

- [ ] **Step 5: Commit only M3A files**

```powershell
git add -- src/atlas/shadow-state.ts src/__tests__/shadow-state.test.ts
git commit -m "feat(atlas): Add strict shadow state comparison"
```

Do not stage roadmap files or any pre-existing dirty path in this code commit.
