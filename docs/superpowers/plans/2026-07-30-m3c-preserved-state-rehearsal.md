# M3C Preserved-State Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain one strict outside-repository exec-graph snapshot, cold-replay
only that copy, prove rollback and cleanup before a bound receipt, and reverify
the durable artifact without changing live Atlas state.

**Architecture:** First harden M3B so proof-producing calls have fixed
dependencies and derived paths while fault injection remains behind a checked
test seam. Then add one explicit-path M3C module for atomic preservation,
rehearsal, strict receipts, safe cleanup, and read-only verification. A bounded
script drives fixture tests and, only after independent diff review, one real
retained-copy drill.

**Tech Stack:** Node.js 22.13+, TypeScript ESM, `node:fs`, `node:path`,
`node:crypto`, Zod 4, Vitest 2, tsx.

## Global Constraints

- Branch remains `codex/atlas-cost-router-design`; no new worktree is required
  because this branch already owns the M3 sequence.
- Preserve unrelated dirty paths exactly: `docs/atlas-cto/FABLE-PROTOCOL.md`,
  `state/exec-graph/graph.json`, `state/exec-graph/ledger.jsonl`,
  `docs/atlas-cto/VOLAURA-LEARNING-ENGINE-HANDOFF-2026-07-25.md`, and
  `state/evidence/`.
- No live resolver, environment, process, scheduler, Railway, Telegram,
  junction, worktree, ignore, untrack, move, push, merge, deploy, or network
  mutation.
- Tests use generated fixtures and temporary directories only; no test reads
  the real `state/exec-graph` or preservation root.
- Public proof APIs expose no writer, child script, rollback, clock, hash,
  comparison, cleanup, manifest, or receipt injection parameter.
- `childTimeoutMs` defaults to `15_000` and accepts only safe integers from 1
  through `30_000`.
- Recursive cleanup requires lexical and real-path direct-child containment,
  generated prefix, and a normal directory rather than link/junction/reparse
  point.
- Success receipt writing remains unreachable until rollback and exact work
  cleanup are both observed.
- One LUNA/Sonnet lane may own Task 5 mechanical CLI wiring only. Codex SOL owns
  Tasks 1–4, all local verification, external-review disposition, and closure.
- Each task uses RED → GREEN → focused regression → commit. Never batch a red
  test with unrelated implementation.

---

## File map

- Create `src/atlas/shadow-rehearsal-test-seam.ts`: test-only override storage,
  default resolver, and scoped installer.
- Modify `src/atlas/shadow-rehearsal.ts`: fixed wrappers, derived M3B paths,
  bounded timeout, strict/atomic M3B receipt.
- Create `src/__tests__/shadow-rehearsal-seam-boundary.test.ts`: mechanical
  importer allowlist.
- Modify `src/__tests__/shadow-rehearsal.test.ts`: fixed-path and failure
  regressions.
- Modify `src/__tests__/shadow-rehearsal-durability.test.ts`: receipt flush
  regression.
- Create `src/atlas/preserved-state-rehearsal.ts`: M3C preservation, rehearsal,
  cleanup, manifest/receipt schemas, and verifier.
- Create `src/__tests__/fixtures/exec-graph-shadow-fixture.ts`: generated valid
  fixture helper used only by new M3C tests.
- Create `src/__tests__/preserved-state-preservation.test.ts`: stable-window,
  path, atomic-copy, and manifest tests.
- Create `src/__tests__/preserved-state-rehearsal.test.ts`: cold replay,
  rollback, tamper, receipt-order, and verifier tests.
- Create `src/__tests__/preserved-state-cleanup.test.ts`: real-path/junction and
  cleanup-failure tests.
- Create `src/__tests__/preserved-state-durability.test.ts`: data/manifest/
  receipt flush observation.
- Create `scripts/rehearse-preserved-exec-graph.mts`: explicit `run` and
  `verify` entry points with sanitized output.
- Create `src/__tests__/preserved-state-cli.test.ts`: missing-argument,
  successful fixture, and verify-only child-process tests.
- Create `src/__tests__/fixtures/forbid-network.mjs`: child-process preload that
  throws on fetch/HTTP/HTTPS/TCP/TLS use.
- Modify `package.json`: add one explicit M3C script alias.
- Modify `docs/atlas-cto/ATLAS-STATE-NOW.md` and
  `docs/atlas-cto/ATLAS-MASTER-PLAN.md` only after command evidence exists.

---

### Task 1: Lock M3B injection behind a mechanical test boundary

**Files:**

- Create: `src/atlas/shadow-rehearsal-test-seam.ts`
- Create: `src/__tests__/shadow-rehearsal-seam-boundary.test.ts`
- Modify: `src/atlas/shadow-rehearsal.ts:20-220`
- Modify: `src/__tests__/shadow-rehearsal.test.ts:154-380`

**Interfaces:**

- Produces:
  `resolveShadowRehearsalDependencies(defaults)` for the one allowlisted
  production importer and `withShadowRehearsalTestOverrides(overrides, fn)` for
  tests only.
- Preserves fixed production wrappers:
  `copyExecGraphDirectoryAtomic(source, parent, name)` and
  `coldReplayExecGraphDirectory(shadow, { timeoutMs? })`.
- Adds rollback dependency `executeRollback(shadowRoot)` to the bounded seam so
  Task 4 can falsify rollback without a public proof option.

- [ ] **Step 1: Write RED tests proving old low-level inputs are reachable**

Add these production-shape cases to `shadow-rehearsal.test.ts`:

```ts
it('ignores a cast writer on the fixed production copy wrapper', () => {
  const source = writeValidGraphFixture('cast-writer-source');
  const workDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-cast-writer-'));
  const forged = vi.fn(() => {
    throw new Error('forged writer ran');
  });

  try {
    expect(() =>
      (copyExecGraphDirectoryAtomic as unknown as (...args: unknown[]) => string)(
        source,
        workDir,
        'shadow',
        forged,
      ),
    ).not.toThrow();
    expect(forged).not.toHaveBeenCalled();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

it('ignores a cast child script on the fixed cold-replay wrapper', () => {
  const validShadow = writeValidGraphFixture('cast-child-shadow');
  const faultScript = writeFaultScript('cast-child.ts', 'process.exit(47);\n');
  const result = (
    coldReplayExecGraphDirectory as unknown as (
      root: string,
      options: Record<string, unknown>,
    ) => ChildReplayResult
  )(validShadow, { childScriptPath: faultScript });

  expect(result.eventCount).toBe(2);
});
```

- [ ] **Step 2: Run the two tests and observe the intended failures**

Run:

```powershell
npx vitest run src/__tests__/shadow-rehearsal.test.ts -t "cast writer|cast child script"
```

Expected: forged writer executes and forged child controls the replay; exit is
nonzero.

- [ ] **Step 3: Create the scoped test seam**

Create `shadow-rehearsal-test-seam.ts` with this complete public shape:

```ts
export type ShadowFileWriter = (destinationPath: string, contents: Buffer) => void;

export interface ShadowRehearsalDependencies {
  readonly fileWriter: ShadowFileWriter;
  readonly childScriptPath: string;
  readonly executeRollback: (shadowRoot: string) => void;
}

let override: Partial<ShadowRehearsalDependencies> | undefined;

export function resolveShadowRehearsalDependencies<T extends ShadowRehearsalDependencies>(
  defaults: T,
): T {
  return override ? ({ ...defaults, ...override } as T) : defaults;
}

export function withShadowRehearsalTestOverrides<T>(
  next: Partial<ShadowRehearsalDependencies>,
  fn: () => T,
): T {
  const previous = override;
  override = next;
  try {
    return fn();
  } finally {
    override = previous;
  }
}
```

In `shadow-rehearsal.ts`, remove `fileWriter` and `childScriptPath` from public
signatures. Build module-private defaults, resolve them inside the fixed
wrappers, and call `dependencies.executeRollback` from the orchestrator.

- [ ] **Step 4: Move existing fault tests to the scoped installer**

Replace direct writer/script arguments with:

```ts
withShadowRehearsalTestOverrides({ fileWriter: faultyWriter }, () => {
  expect(() => copyExecGraphDirectoryAtomic(source, workDir, 'shadow')).toThrow(
    expect.objectContaining({ code: 'copy_interrupted' }),
  );
});

withShadowRehearsalTestOverrides({ childScriptPath: faultScript }, () => {
  expect(() => coldReplayExecGraphDirectory(shadow)).toThrow(
    expect.objectContaining({ code: 'replay_nonzero_exit' }),
  );
});
```

- [ ] **Step 5: Add the importer boundary test**

Clone the source-scanning structure from
`cost-router-seam-boundary.test.ts`. Set:

```ts
const SEAM_FILE = resolve(SRC_ROOT, 'atlas', 'shadow-rehearsal-test-seam.ts');
const ALLOWED_OUTSIDE_IMPORTER = resolve(SRC_ROOT, 'atlas', 'shadow-rehearsal.ts');
const ALLOWED_OUTSIDE_IMPORTER_SPECIFIERS = [
  'resolveShadowRehearsalDependencies',
  'ShadowRehearsalDependencies',
];
```

Normalize `type` prefixes before comparing names. Fail when any non-test file
imports `withShadowRehearsalTestOverrides`, or any production file other than
`shadow-rehearsal.ts` imports the seam.

- [ ] **Step 6: Run Task 1 GREEN and regressions**

Run:

```powershell
npx vitest run src/__tests__/shadow-rehearsal.test.ts src/__tests__/shadow-rehearsal-durability.test.ts src/__tests__/shadow-rehearsal-seam-boundary.test.ts
npx tsc --noEmit
git diff --check
```

Expected: all listed tests pass; typecheck and diff-check exit 0.

- [ ] **Step 7: Commit Task 1 only**

```powershell
git add -- src/atlas/shadow-rehearsal-test-seam.ts src/atlas/shadow-rehearsal.ts src/__tests__/shadow-rehearsal.test.ts src/__tests__/shadow-rehearsal-seam-boundary.test.ts
git commit -m "refactor(shadow): Bound rehearsal test seams"
```

---

### Task 2: Derive M3B proof paths and bound child time

**Files:**

- Modify: `src/atlas/shadow-rehearsal.ts:39-490`
- Modify: `src/__tests__/shadow-rehearsal.test.ts:108-370`
- Modify: `src/__tests__/shadow-rehearsal-durability.test.ts`

**Interfaces:**

- `ShadowRehearsalOptions` becomes exactly
  `{ workDirectory: string; childTimeoutMs?: number }`.
- `RehearsalReceipt` gains resolved `receiptPath`.
- Export `rehearsalReceiptSchema` for Task 4 strict readback.
- Fixed receipt basename: `shadow-rehearsal-receipt.json`.

- [ ] **Step 1: Write RED proof-path and timeout tests**

Add tests that:

```ts
const castOptions = {
  workDirectory: workDir,
  receiptPath: join(sandboxDir, 'forged.json'),
  shadowRootName: 'forged-shadow',
} as unknown as ShadowRehearsalOptions;

const receipt = runShadowRehearsal(source, castOptions);
expect(receipt.receiptPath).toBe(join(resolve(workDir), 'shadow-rehearsal-receipt.json'));
expect(existsSync(join(sandboxDir, 'forged.json'))).toBe(false);
expect(receipt.shadowRoot).not.toContain('forged-shadow');
```

Also assert `0`, `30_001`, `1.5`, `NaN`, and `Infinity` produce
`timeout_invalid` before `workDirectory` gains any entries.

- [ ] **Step 2: Run RED tests**

```powershell
npx vitest run src/__tests__/shadow-rehearsal.test.ts -t "derives proof paths|timeout_invalid"
```

Expected: current caller paths are honored and timeout values are unbounded.

- [ ] **Step 3: Implement exact option and error contracts**

Use:

```ts
const DEFAULT_CHILD_TIMEOUT_MS = 15_000;
const MAX_CHILD_TIMEOUT_MS = 30_000;
const RECEIPT_BASENAME = 'shadow-rehearsal-receipt.json';

function requireChildTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CHILD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CHILD_TIMEOUT_MS) {
    throw new ShadowRehearsalError(
      'timeout_invalid',
      `child timeout must be a safe integer from 1 through ${MAX_CHILD_TIMEOUT_MS}ms`,
    );
  }
  return timeout;
}
```

Validate timeout and refuse an existing derived receipt before source
inspection, shadow creation, or other mutation. Generate the shadow name with
`shadow-${randomUUID()}` and never read unknown option keys.

- [ ] **Step 4: Persist the derived M3B receipt atomically**

The private writer must:

```ts
const receiptPath = join(resolve(workDirectory), RECEIPT_BASENAME);
const temporaryPath = join(
  resolve(workDirectory),
  `.shadow-rehearsal-receipt-${randomUUID()}.tmp`,
);
if (existsSync(receiptPath)) {
  throw new ShadowRehearsalError('receipt_exists', `refusing to overwrite ${receiptPath}`);
}
writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
  encoding: 'utf8',
  flush: true,
});
renameSync(temporaryPath, receiptPath);
```

Repeat the existing-receipt check immediately before rename to close the normal
race without overwriting. On failure, remove only the exact temporary file and
throw `receipt_write_failed`. Strictly parse the persisted bytes with an
exported `.strict()` Zod schema before returning.

- [ ] **Step 5: Extend durability and overwrite tests**

Capture writes whose basename starts `.shadow-rehearsal-receipt-`; require
`flush: true`. Run twice against the same work directory and require the second
call to fail `receipt_exists` before creating a new shadow.

- [ ] **Step 6: Run Task 2 GREEN and regressions**

```powershell
npx vitest run src/__tests__/shadow-rehearsal.test.ts src/__tests__/shadow-rehearsal-durability.test.ts src/__tests__/shadow-rehearsal-seam-boundary.test.ts
npx tsc --noEmit
git diff --check
```

- [ ] **Step 7: Commit Task 2 only**

```powershell
git add -- src/atlas/shadow-rehearsal.ts src/__tests__/shadow-rehearsal.test.ts src/__tests__/shadow-rehearsal-durability.test.ts
git commit -m "fix(shadow): Derive proof paths and timeout"
```

---

### Task 3: Preserve a stable exec-graph snapshot atomically

**Files:**

- Create: `src/atlas/preserved-state-rehearsal.ts`
- Create: `src/__tests__/fixtures/exec-graph-shadow-fixture.ts`
- Create: `src/__tests__/preserved-state-preservation.test.ts`
- Create: `src/__tests__/preserved-state-durability.test.ts`

**Interfaces:**

- Produces:

```ts
preserveExecGraphSnapshot(options: {
  sourceDirectory: string;
  preservationParentDirectory: string;
  artifactName: string;
}): PreservedExecGraphManifest
```

- Manifest has strict schema version/kind, final resolved paths, S0/S1/S2/P0
  hashes/counts, comparison booleans, `sourceStable: true`, and
  `preservationAccepted: true`.

- [ ] **Step 1: Create the fixture helper and RED happy-path test**

The helper exports `writeExecGraphFixture(parent, name, title?)` and writes two
valid events plus the exact folded snapshot. The test calls the missing public
function and expects:

```ts
expect(manifest).toMatchObject({
  schemaVersion: 1,
  kind: 'atlas.exec-graph-preservation',
  sourceStable: true,
  preservationAccepted: true,
  comparison: {
    ledgerBytesEqual: true,
    semanticStateEqual: true,
    countsEqual: true,
    accepted: true,
  },
});
expect(readdirSync(artifactDirectory).sort()).toEqual([
  'exec-graph',
  'preservation-manifest.json',
]);
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/__tests__/preserved-state-preservation.test.ts
```

Expected: module/function missing.

- [ ] **Step 3: Define strict schemas and path validation**

Use Zod `.strict()` objects for inspections, comparison, and manifest. Validate:

```ts
const ARTIFACT_NAME_RE = /^atlas-exec-graph-m3c-\d{8}T\d{6}Z-[a-f0-9]{8}$/;

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}
```

Require absolute source/parent, strict artifact basename, existing normal
parent directory, no source/parent overlap in either direction, and absent final
artifact before creating staging.

- [ ] **Step 4: Implement S0/S1/S2/P0 stable-window preservation**

Use this exact order:

```ts
const sourceBefore = inspectExecGraphDirectory(source);
mkdirSync(stagingDirectory, { recursive: false });
copyExecGraphDirectoryAtomic(source, stagingDirectory, 'exec-graph');
const sourceAfterCopy = inspectExecGraphDirectory(source);
const comparison = compareExecGraphDirectories(source, stagingPreservedDirectory);
assertStable(sourceBefore, sourceAfterCopy, comparison.source);
assertAccepted(comparison);
writeFileSync(manifestPathInStaging, serializedManifest, {
  encoding: 'utf8',
  flush: true,
});
renameSync(stagingDirectory, artifactDirectory);
```

Define both guards in this task; compare all proof fields, not object identity:

```ts
function inspectionsMatch(left: ExecGraphInspection, right: ExecGraphInspection): boolean {
  return (
    left.ledgerSha256 === right.ledgerSha256 &&
    left.snapshotSha256 === right.snapshotSha256 &&
    left.semanticSha256 === right.semanticSha256 &&
    left.eventCount === right.eventCount &&
    left.goalCount === right.goalCount &&
    left.taskCount === right.taskCount
  );
}

function assertStable(...observations: ExecGraphInspection[]): void {
  if (observations.slice(1).some((item) => !inspectionsMatch(observations[0], item))) {
    throw new PreservedStateRehearsalError(
      'source_mutated',
      'source changed during the preservation observation window',
    );
  }
}

function assertAccepted(comparison: ShadowStateComparison): void {
  if (!comparison.accepted) {
    throw new PreservedStateRehearsalError(
      'preservation_mismatch',
      `preserved copy comparison failed: ${comparison.blocker}`,
    );
  }
}
```

Manifest inspection values omit staging directory names; top-level paths bind
only final resolved source/artifact/preserved paths. Read back and strictly
validate the final manifest and final preserved directory before returning.

- [ ] **Step 5: Add RED→GREEN failure cases**

Use `withShadowRehearsalTestOverrides({ fileWriter })` to produce deterministic
source mutation and divergent-copy cases. Add exact assertions for:

- `source_mutated`, no final artifact, no `.m3c-staging-` residue;
- `preservation_mismatch`, same absence guarantees;
- existing artifact unchanged;
- malformed/missing/empty source preserves M3A error code;
- relative/overlap/traversal/separator names fail before creation;
- manifest write observes `{ encoding: 'utf8', flush: true }`.

- [ ] **Step 6: Run Task 3 GREEN**

```powershell
npx vitest run src/__tests__/preserved-state-preservation.test.ts src/__tests__/preserved-state-durability.test.ts src/__tests__/shadow-rehearsal-seam-boundary.test.ts
npx tsc --noEmit
git diff --check
```

- [ ] **Step 7: Commit Task 3 only**

```powershell
git add -- src/atlas/preserved-state-rehearsal.ts src/__tests__/fixtures/exec-graph-shadow-fixture.ts src/__tests__/preserved-state-preservation.test.ts src/__tests__/preserved-state-durability.test.ts
git commit -m "feat(shadow): Preserve exec graph snapshot"
```

---

### Task 4: Rehearse, clean up, receipt, and independently verify

**Files:**

- Modify: `src/atlas/preserved-state-rehearsal.ts`
- Create: `src/__tests__/preserved-state-rehearsal.test.ts`
- Create: `src/__tests__/preserved-state-cleanup.test.ts`
- Modify: `src/__tests__/preserved-state-durability.test.ts`

**Interfaces:**

- Produces:

```ts
rehearsePreservedExecGraph(options: {
  artifactDirectory: string;
  childTimeoutMs?: number;
}): PreservedStateRehearsalReceipt

verifyPreservedStateRehearsal(
  artifactDirectory: string,
): VerifiedPreservedStateRehearsal
```

Define the verifier result exactly:

```ts
export interface VerifiedPreservedStateRehearsal {
  readonly verified: true;
  readonly manifestSha256: string;
  readonly manifest: PreservedExecGraphManifest;
  readonly receipt: PreservedStateRehearsalReceipt;
}
```

- M3C receipt binds manifest SHA-256, exact artifact/preserved/work paths,
  preserved hashes/counts, nested strict M3B receipt, four accepted booleans,
  and `workDirectoryAbsent: true`.

- [ ] **Step 1: Write the RED happy path and no-receipt failure tests**

Happy path requires the final artifact layout and these facts:

```ts
expect(receipt).toMatchObject({
  schemaVersion: 1,
  kind: 'atlas.m3c-preserved-state-rehearsal',
  preservationAccepted: true,
  coldReplayAccepted: true,
  rollbackVerified: true,
  preservedStateUnchanged: true,
  workDirectoryAbsent: true,
});
expect(existsSync(receipt.workDirectory)).toBe(false);
expect(existsSync(receipt.m3bReceipt.shadowRoot)).toBe(false);
expect(verifyPreservedStateRehearsal(artifactDirectory).verified).toBe(true);
```

With a nonzero child test script in the bounded seam, require
`rehearsal_failed` and no `rehearsal-receipt.json`. With no-op rollback in the
seam, require the same no-receipt result.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/__tests__/preserved-state-rehearsal.test.ts
```

Expected: rehearsal/verifier exports missing.

- [ ] **Step 3: Implement strict readback and work creation**

Validate timeout before mutation. Read raw manifest bytes, hash them, parse
strictly, and require every manifest path to equal the derived resolved path.
Reinspect preserved files before creating `.m3c-work-${randomUUID()}` as a
normal sibling of the artifact.

- [ ] **Step 4: Bind and validate the M3B receipt**

Call only:

```ts
const m3bReceipt = runShadowRehearsal(preservedDirectory, {
  workDirectory,
  childTimeoutMs: timeout,
});
```

Read the fixed M3B receipt from `m3bReceipt.receiptPath`, parse it with
`rehearsalReceiptSchema`, and require exact equality with the returned object.
Require its source path/hashes/counts to match the preserved manifest and its
shadow path to be absent.

- [ ] **Step 5: Implement safe recursive cleanup**

Before `rmSync(target, { recursive: true, force: true })`, enforce:

```ts
const lexicalParent = resolve(parent);
const lexicalTarget = resolve(target);
if (dirname(lexicalTarget) !== lexicalParent || !basename(lexicalTarget).startsWith(prefix)) {
  throw cleanupUnsafe(target);
}
const stat = lstatSync(lexicalTarget);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw cleanupUnsafe(target);
const realParent = realpathSync.native(lexicalParent);
const realTarget = realpathSync.native(lexicalTarget);
if (dirname(realTarget) !== realParent) throw cleanupUnsafe(target);
```

`cleanupUnsafe` is not a later placeholder; define it as:

```ts
function cleanupUnsafe(target: string): PreservedStateRehearsalError {
  return new PreservedStateRehearsalError(
    'cleanup_unsafe',
    `refusing recursive cleanup outside the generated direct-child boundary: ${target}`,
  );
}
```

After removal, `existsSync(target)` must be false. A cleanup failure supersedes
the underlying rehearsal error and leaves no M3C receipt.

- [ ] **Step 6: Make cleanup structurally precede the M3C receipt**

After M3B success, reinspect preserved state. Build the prospective receipt,
clean and observe the work directory, then and only then write
`.m3c-receipt-${randomUUID()}` with `{ encoding: 'utf8', flush: true }`, rename
to `rehearsal-receipt.json`, and invoke the independent verifier. Never call the
receipt writer from a `finally` block.

- [ ] **Step 7: Add the remaining falsifiers**

Add exact cases for:

- preserved ledger and snapshot tampered before rehearsal;
- preserved source mutated during rollback through the scoped seam;
- malformed/unknown-field/path-mismatched manifest before child spawn;
- post-receipt manifest/receipt/preserved-file tamper;
- second receipt attempt without overwrite;
- cleanup failure never invoking receipt write;
- mocked real path escaping through a lexically valid junction, with `rmSync`
  spy remaining at zero;
- cast writer/child/receipt/name payload ignored;
- CWD and `ATLAS_EXEC_GRAPH_DIR` changes having no effect.

- [ ] **Step 8: Run Task 4 GREEN**

```powershell
npx vitest run src/__tests__/preserved-state-preservation.test.ts src/__tests__/preserved-state-rehearsal.test.ts src/__tests__/preserved-state-cleanup.test.ts src/__tests__/preserved-state-durability.test.ts src/__tests__/shadow-rehearsal.test.ts src/__tests__/shadow-rehearsal-seam-boundary.test.ts
npx tsc --noEmit
git diff --check
```

- [ ] **Step 9: Commit Task 4 only**

```powershell
git add -- src/atlas/preserved-state-rehearsal.ts src/__tests__/preserved-state-rehearsal.test.ts src/__tests__/preserved-state-cleanup.test.ts src/__tests__/preserved-state-durability.test.ts
git commit -m "feat(shadow): Rehearse preserved state"
```

---

### Task 5: Add the bounded explicit-path drill script

**Files:**

- Create: `scripts/rehearse-preserved-exec-graph.mts`
- Create: `src/__tests__/preserved-state-cli.test.ts`
- Create: `src/__tests__/fixtures/forbid-network.mjs`
- Modify: `package.json:scripts`

**Interfaces:**

- `run` mode requires `--source`, `--preservation-parent`, and
  `--artifact-name`.
- `verify` mode requires only `--artifact`.
- Stdout contains sanitized JSON summary only; stderr contains stable code and
  message only; no ledger/snapshot content.

This is the only bounded mechanical lane eligible for LUNA/Sonnet: one scope,
20 minutes, no grandchildren, stop on first policy/capability block. Codex
reviews the diff and reruns every command.

- [ ] **Step 1: Write RED CLI tests**

Spawn with `process.execPath` plus the repository tsx CLI. Assert missing args
exit nonzero with `path_invalid` and create no directory. Run against temporary
fixture paths and assert output parses as:

```ts
{
  status: 'accepted',
  artifactDirectory: expect.any(String),
  manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  eventCount: 2,
  goalCount: 1,
  taskCount: 1,
  rollbackVerified: true,
  workDirectoryAbsent: true,
}
```

Then spawn `verify --artifact <path>` in a fresh process and require the same
hashes/counts with `verified: true`.

Run both successful child processes with `NODE_OPTIONS=--import
<absolute-file-URL-to-forbid-network.mjs>`. The preload replaces
`globalThis.fetch`, `http.request`, `https.request`, `net.connect`, and
`tls.connect` with functions that throw `network forbidden`; successful CLI
exit proves no covered network entry was used.

Create the preload with actual guards:

```js
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const deny = () => {
  throw new Error('network forbidden');
};

globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
tls.connect = deny;
dgram.createSocket = deny;
dns.lookup = deny;
dns.resolve = deny;
syncBuiltinESMExports();
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/__tests__/preserved-state-cli.test.ts
```

Expected: script missing.

- [ ] **Step 3: Implement explicit parsing and sanitized output**

Use `parseArgs({ strict: true, allowPositionals: true })`. Refuse unknown mode,
missing values, or non-absolute directory arguments before calling any M3C
function. `run` calls preserve → rehearse → verify. `verify` calls only the
read-only verifier. Narrow `unknown` errors rather than casting them:

```ts
const refusal = error instanceof PreservedStateRehearsalError
  ? { code: error.code, message: error.message }
  : { code: 'unexpected_error', message: error instanceof Error ? error.message : String(error) };
console.error(JSON.stringify({ status: 'refused', ...refusal }));
process.exitCode = 1;
```

Never serialize raw manifest, nested M3B receipt, ledger rows, snapshot objects,
environment, or stack trace.

- [ ] **Step 4: Add package alias**

```json
"atlas:m3c-rehearse": "tsx scripts/rehearse-preserved-exec-graph.mts"
```

- [ ] **Step 5: Run Task 5 GREEN**

```powershell
npx vitest run src/__tests__/preserved-state-cli.test.ts src/__tests__/preserved-state-preservation.test.ts src/__tests__/preserved-state-rehearsal.test.ts
npx tsc --noEmit
git diff --check
```

- [ ] **Step 6: Codex reviews and commits Task 5**

```powershell
git add -- scripts/rehearse-preserved-exec-graph.mts src/__tests__/preserved-state-cli.test.ts src/__tests__/fixtures/forbid-network.mjs package.json
git commit -m "feat(shadow): Add preserved-state drill CLI"
```

---

### Task 6: Verify code, close diff review, and run one retained-copy drill

**Files:**

- Modify after evidence: `docs/atlas-cto/ATLAS-STATE-NOW.md`
- Modify after evidence: `docs/atlas-cto/ATLAS-MASTER-PLAN.md`
- Update outside Git: `C:\Projects\VOLAURA\memory\atlas\CURRENT-COMPACT.md`
- Append outside Git: `C:\Projects\VOLAURA\memory\atlas\codex-loop.md`

**Interfaces:**

- Consumes all Task 1–5 APIs.
- Produces one retained artifact under
  `C:\Projects\VOLAURA\memory\atlas\preservation` and one evidence closure.
- Does not authorize M3D/M4 cutover.

- [ ] **Step 1: Run fresh local code gates**

```powershell
npx vitest run src/__tests__/shadow-state.test.ts src/__tests__/shadow-rehearsal.test.ts src/__tests__/shadow-rehearsal-durability.test.ts src/__tests__/shadow-rehearsal-seam-boundary.test.ts src/__tests__/preserved-state-preservation.test.ts src/__tests__/preserved-state-rehearsal.test.ts src/__tests__/preserved-state-cleanup.test.ts src/__tests__/preserved-state-durability.test.ts src/__tests__/preserved-state-cli.test.ts src/__tests__/state-root.test.ts src/__tests__/cost-router-state.test.ts src/__tests__/cost-router-classify.test.ts src/__tests__/cost-router-error-policy.test.ts src/__tests__/cost-router-clearance.test.ts src/__tests__/cost-router-m2d-integration.test.ts src/__tests__/cost-router-seam-boundary.test.ts src/__tests__/exec-graph.test.ts
npx tsc --noEmit
git diff --check
git status --short
```

Expected: zero failures; typecheck/diff-check exit 0; only the five known
unrelated dirty paths remain after task commits.

- [ ] **Step 2: Run one bounded Opus/Fable diff review**

Give only the committed design path, Task 1–5 commit range, and changed file
paths. Maximum 10 direct Read/Search calls; no Agent, Bash, edit, polling, or
completion claim. Codex verifies every material finding locally, records
`ACCEPT`/`MODIFY`/`REJECT`/`UNVERIFIED`, repairs with RED→GREEN tests when
needed, and reruns Step 1. Never start a second review loop merely for
reassurance.

- [ ] **Step 3: Read-only real-drill preflight**

Verify exact branch/HEAD, five-path dirty allowlist, `AtlasRunner` state, source
inspection hashes/counts, absent final artifact, and VOLAURA tracking state:

```powershell
Get-ScheduledTask -TaskName AtlasRunner | Select-Object TaskName,State
git status --short
git -C C:\Projects\VOLAURA ls-files 'memory/atlas/preservation/**'
git -C C:\Projects\VOLAURA status --short -- 'memory/atlas/preservation'
```

If runner state is `Running`, source inspection differs from the recorded
baseline, or artifact/tracking preflight fails: stop with named blocker. Do not
stop the runner or change scheduler state.

- [ ] **Step 4: Run exactly one real retained-copy rehearsal**

Generate one strict UTC artifact name, then run:

```powershell
npm run atlas:m3c-rehearse -- run --source 'C:\Users\user\OneDrive\Documents\GitHub\ANUS\state\exec-graph' --preservation-parent 'C:\Projects\VOLAURA\memory\atlas\preservation' --artifact-name '<preflighted strict artifact name>'
```

Expected: exit 0 and sanitized accepted summary. Do not rerun on the same or a
new artifact after any policy/invariant failure; inspect the named blocker.

- [ ] **Step 5: Verify in a fresh process and recheck source/Git state**

```powershell
npm run atlas:m3c-rehearse -- verify --artifact '<exact artifact path from Step 4>'
git status --short
git -C C:\Projects\VOLAURA ls-files --error-unmatch 'memory/atlas/preservation/<exact artifact name>/**'
git -C C:\Projects\VOLAURA diff --cached --name-only -- 'memory/atlas/preservation/<exact artifact name>/**'
git -C C:\Projects\VOLAURA status --short -- 'memory/atlas/preservation/<exact artifact name>'
```

Require matching manifest/source/preserved hashes and counts, absent shadow and
work paths, valid receipt, and unchanged ANUS source hashes/status. The
`ls-files --error-unmatch` command must exit nonzero, cached diff must be empty,
and status must show only `??` for the exact artifact. Retain the artifact; do
not delete or archive it.

- [ ] **Step 6: Record evidence and commit roadmap closure**

Update both roadmap docs with exact commits, commands, counts, artifact path,
manifest SHA-256, and `M3C VERIFIED / M3D PLAN NEXT`. Update CURRENT-COMPACT and
append codex-loop disposition. Then:

```powershell
git add -- docs/atlas-cto/ATLAS-STATE-NOW.md docs/atlas-cto/ATLAS-MASTER-PLAN.md
git diff --cached --check
git commit -m "docs(atlas): Record M3C rehearsal evidence"
```

- [ ] **Step 7: Final no-cutover proof**

```powershell
git show --stat --oneline HEAD
git status --short
Get-ScheduledTask -TaskName AtlasRunner | Select-Object TaskName,State
```

Report M3C only. M3D/M4, untracking, move, scheduler/Railway updates, push, and
merge remain separate Yusif gates.

---

## Execution ownership

Use inline Codex SOL execution for Tasks 1–4 and 6. Dispatch at most one bounded
LUNA/Sonnet worker for Task 5 after Task 4 is committed; stop that route on its
first policy/capability block. Codex rereads its diff and reruns all Task 5
commands before accepting it.

No decision is required from Yusif before execution. The next strategic gate is
only a proposed M3D/M4 cutover, deletion/archive, scheduler change, move,
untracking, push/merge, or provider activation.
