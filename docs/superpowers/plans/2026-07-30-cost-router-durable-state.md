# Cost Router Durable State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one fail-closed Cost Router record per goal so premium
ownership, escalation ceilings, research-job ceilings, retry counters, and
asynchronous handles survive process restarts.

**Architecture:** Add `cost-router` to the accepted state-root registry. Store
validated JSON at `<ATLAS_STATE_ROOT>/cost-router/goals/<goal-id>.json`.
Serialize every mutation through a per-goal cross-process lock, re-read while
locked, increment a monotonic revision, and atomically replace the file.
Expose bounded mutations only; live providers, scheduling, and routing remain
disabled.

**Tech Stack:** TypeScript, Node.js filesystem primitives, Zod 4, Vitest.

## Global Constraints

- Work only on `codex/atlas-state-root-p2-wave-a-repair`.
- No live provider traffic, browser session, scheduler, deployment, merge,
  push, physical state move, untrack, ignore edit, or call-site migration.
- Default goal ceilings: four local slices, two research jobs, one premium
  escalation, and zero metered API spend.
- One task may enter premium escalation at most once.
- Missing, corrupt, unsafe, or unwritable state fails closed with a named code.
- Preserve unrelated dirty files.

---

### Task 1: Register Cost Router state

**Files:**
- Modify: `src/atlas/state-root.ts`
- Modify: `src/__tests__/state-root.test.ts`

- [x] **Step 1: Write failing registry test**

Add `cost-router` to the exact expected registry and assert:

```ts
process.env.ATLAS_STATE_ROOT = ABSOLUTE_STATE_ROOT;
expect(resolveStateDir('cost-router')).toBe(
  resolve(ABSOLUTE_STATE_ROOT, 'cost-router')
);
```

- [x] **Step 2: Prove red**

```powershell
npx vitest run src/__tests__/state-root.test.ts
```

Expected: TypeScript/runtime assertion fails because `cost-router` is absent.

- [x] **Step 3: Implement registry entry**

```ts
export const STATE_STORES = {
  // existing entries
  'cost-router': undefined,
} as const satisfies Readonly<Record<string, string | undefined>>;
```

- [x] **Step 4: Prove green**

```powershell
npx vitest run src/__tests__/state-root.test.ts
```

Expected: all state-root tests pass.

---

### Task 2: Create and cold-read validated goal records

**Files:**
- Create: `src/atlas/cost-router-state.ts`
- Create: `src/__tests__/cost-router-state.test.ts`

**Public API:**

```ts
export const DEFAULT_GOAL_ROUTER_BUDGET;
export class GoalRouterStateError extends Error {
  readonly code: GoalRouterStateErrorCode;
}
export function createGoalRouterRecord(
  goalId: string,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord>;
export function loadGoalRouterRecord(
  goalId: string,
  options?: GoalRouterStateOptions,
): DurableGoalRouterRecord;
```

- [x] **Step 1: Write failing tests**

Use a fresh temporary root for each test. Assert:

- a new record lands at `cost-router/goals/<goal-id>.json`;
- cold-reading from a new call returns revision `0` and explicit ceilings;
- duplicate creation fails with `goal_exists`;
- missing state fails with `goal_state_missing`;
- malformed or schema-invalid JSON fails with `goal_state_corrupt`;
- `../escape` and unsafe goal IDs fail with `goal_id_invalid`.

- [x] **Step 2: Prove red**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
```

Expected: module import or assertions fail because implementation is absent.

- [x] **Step 3: Implement schema and atomic persistence**

Define strict Zod schemas for `DurableGoalRouterRecord` and
`AsyncResearchHandle`. Resolve production storage through
`resolveStateDir('cost-router')`; tests inject an absolute `rootDir`.

Create directories recursively. Write JSON to a unique sibling temporary file,
flush and close it, then `renameSync()` over the target. Delete a leftover
temporary file on failure. Validate every disk read before returning it.

- [x] **Step 4: Prove green**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
npx tsc --noEmit
```

Expected: focused tests pass; typecheck exits 0.

---

### Task 3: Persist exclusive premium ownership

**Files:**
- Modify: `src/atlas/cost-router-state.ts`
- Modify: `src/__tests__/cost-router-state.test.ts`

**Public API:**

```ts
export function acquirePremiumOwner(
  goalId: string,
  owner: PremiumOwner,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord>;

export function releasePremiumOwner(
  goalId: string,
  phaseId: string,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord>;
```

- [x] **Step 1: Write failing restart tests**

Assert:

- acquisition persists owner, task escalation `1`, used premium count `1`, and
  revision `1`;
- a fresh cold-read sees all four values;
- a second active owner after cold-read fails with `premium_owner_active`;
- a second escalation for the same task fails with
  `task_escalation_exhausted`;
- exhausted goal premium ceiling fails with
  `goal_premium_budget_exhausted`;
- wrong-phase release fails with `premium_owner_mismatch`;
- correct release clears ownership and increments revision.

- [x] **Step 2: Prove red**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
```

- [x] **Step 3: Implement locked read-modify-write**

Acquire `<goal-file>.lock` with exclusive `openSync(..., 'wx')`. While holding
the lock, cold-read and validate the current record, apply exactly one bounded
mutation, increment revision, update `updatedAt`, atomically replace the JSON,
then release the lock in `finally`. A valid unexpired owner blocks every other
phase for the goal. An expired owner may be replaced, but its task escalation
ledger remains consumed.

- [x] **Step 4: Prove green**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
npx tsc --noEmit
```

---

### Task 4: Persist bounded asynchronous research handles

**Files:**
- Modify: `src/atlas/cost-router-state.ts`
- Modify: `src/__tests__/cost-router-state.test.ts`

**Public API:**

```ts
export function registerAsyncResearchHandle(
  goalId: string,
  handle: AsyncResearchHandle,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord>;
```

- [x] **Step 1: Write failing persistence tests**

Assert:

- one valid handle persists and survives cold-read;
- registration increments `usedResearchJobs` and revision;
- goal mismatch fails with `async_handle_goal_mismatch`;
- duplicate handle ID fails with `async_handle_exists`;
- the third research job fails with `goal_research_budget_exhausted`;
- an already expired handle fails locally with `async_handle_expired`.

- [x] **Step 2: Prove red**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
```

- [x] **Step 3: Implement one locked mutation**

Validate the exact handle schema and timestamps before locking. Re-read the
goal under lock. Refuse expired, duplicate, mismatched, or over-budget handles.
Append the handle, increment the research count and revision, then atomically
replace state. Do not invoke or inspect any provider.

- [x] **Step 4: Final local verification**

```powershell
npx vitest run src/__tests__/state-root.test.ts src/__tests__/cost-router-state.test.ts
npx tsc --noEmit
git diff --check
git status --short
```

Expected: all focused tests pass, typecheck exits 0, diff check is clean, and
status contains only owned M1C files.

---

### Task 5: Persist local-slice and retry ceilings

**Files:**
- Modify: `src/atlas/cost-router-state.ts`
- Modify: `src/__tests__/cost-router-state.test.ts`

**Public API:**

```ts
export function consumeLocalSlice(...): Promise<DurableGoalRouterRecord>;
export function recordRetryEvent(
  goalId: string,
  taskId: string,
  event: "denial" | "transport_retry" | "provider_failover",
  now: string,
  options?: GoalRouterStateOptions,
): Promise<DurableGoalRouterRecord>;
```

- [x] **Step 1: Write failing persistence tests**

Assert that four local slices persist and the fifth fails with
`goal_local_slice_budget_exhausted`. Assert retry/failover counts survive
cold-read, a second transport retry or provider failover is refused, and a
denial prevents every later retry/failover for that task.

- [x] **Step 2: Prove red**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
```

- [x] **Step 3: Implement locked bounded mutations**

Use the existing per-goal mutation primitive. Increment only the selected
counter. Caps are one denial observation, one transport retry, and one cheap
provider failover per task. A recorded denial is terminal and blocks later
retry events. Increment revision and `updatedAt` atomically.

- [x] **Step 4: Re-run final local verification**

```powershell
npx vitest run src/__tests__/state-root.test.ts src/__tests__/cost-router-state.test.ts
npx tsc --noEmit
git diff --check
git status --short
```

## Stop Rule

Stop immediately on permission/policy/capability denial, an overlapping writer,
or an unexpected dirty file in the isolated worktree. Do not retry through
another model. One deterministic test or type failure may be diagnosed and
repaired locally; scope growth becomes a later slice.
