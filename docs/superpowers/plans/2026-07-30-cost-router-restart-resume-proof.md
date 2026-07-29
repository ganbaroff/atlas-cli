# Cost Router Restart and Resume Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Cost Router ownership and counters survive a real process
restart, then make one scheduled async-resume event claimable exactly once
with local terminal handling for expired or unknown handles.

**Architecture:** Keep provider-free state logic in
`src/atlas/cost-router-state.ts`. A child-process fixture cold-reads the same
absolute test root and attempts a conflicting premium acquisition. Async resume
claims run under the existing per-goal lock and persist one
`resumeClaimedAt` marker plus the inspection count before a caller may inspect
a provider.

**Tech Stack:** TypeScript, Node.js child processes, `node --import tsx`,
Vitest, fake provider spies.

## Global Constraints

- Work only on `codex/atlas-state-root-p2-wave-a-repair`.
- No live provider, browser, scheduler, network, runtime-state migration,
  merge, push, deployment, or physical move.
- One scheduled event may be claimed once. A second claim fails closed.
- Before `nextResumeAt`, no claim and no state mutation.
- Expired, unknown, or inspection-exhausted handles resolve locally and never
  authorize a provider call.
- Preserve all unrelated dirty files.

---

### Task 1: Prove restart durability in a fresh process

**Files:**
- Create: `src/__tests__/fixtures/cost-router-state-child.ts`
- Modify: `src/__tests__/cost-router-state.test.ts`

- [x] **Step 1: Write a child-process acceptance test**

Parent process creates a goal, consumes one local slice and transport retry,
then acquires a premium owner. Spawn:

```powershell
node --import tsx src/__tests__/fixtures/cost-router-state-child.ts `
  inspect-and-conflict <absolute-root> <goal-id> <now>
```

The fixture cold-reads the record, attempts a second premium owner, and emits
compact JSON containing persisted revision/counters/owner plus the rejection
code.

- [x] **Step 2: Prove red**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
```

Expected: fixture is absent or does not emit the required receipt.

- [x] **Step 3: Implement the bounded fixture**

Accept only the exact action and four positional arguments. Import the
production state module, load from the injected absolute store root, attempt
one conflicting acquisition, print one JSON receipt, and exit nonzero on any
unexpected result. No polling or retry.

- [x] **Step 4: Prove green**

Expected receipt contains the original owner, one used slice, one transport
retry, one premium escalation, and `premium_owner_active`.

---

### Task 2: Claim one scheduled resume exactly once

**Files:**
- Modify: `src/atlas/cost-router-state.ts`
- Modify: `src/__tests__/cost-router-state.test.ts`

**Public API:**

```ts
export type AsyncResumeClaimResult =
  | {
      status: "claimed";
      handle: AsyncResearchHandle;
      record: DurableGoalRouterRecord;
    }
  | {
      status: "async_expired";
      reason: "unknown" | "expired" | "inspection_budget_exhausted";
      handleId: string;
      record: DurableGoalRouterRecord;
    };

export function claimScheduledAsyncResume(
  goalId: string,
  handleId: string,
  now: string,
  options?: GoalRouterStateOptions,
): Promise<AsyncResumeClaimResult>;
```

- [x] **Step 1: Write failing due/not-due/exact-once tests**

Assert:

- before `nextResumeAt`: `async_resume_not_due`, unchanged revision/count;
- at due time: status `claimed`, `resumeClaimedAt=now`,
  `inspectionCount+1`, revision incremented;
- a cold-read sees the marker and count;
- a second claim fails with `async_resume_already_claimed`;
- two concurrent claims yield one claim and one named refusal.

- [x] **Step 2: Prove red**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
```

- [x] **Step 3: Implement atomic claim**

Extend the strict handle schema with optional `resumeClaimedAt`. Reject it on
new-handle registration. Under the per-goal lock, cold-read the record, locate
the scheduled handle, check due/expiry/inspection budget, set the marker and
increment the inspection count, then atomically replace the goal record.

- [x] **Step 4: Prove green**

Run the focused test file and typecheck.

---

### Task 3: Resolve expired and unknown handles without provider calls

**Files:**
- Modify: `src/atlas/cost-router-state.ts`
- Modify: `src/__tests__/cost-router-state.test.ts`

- [x] **Step 1: Write failing zero-call tests**

Use a fake provider spy that is invoked only for a `claimed` result. Assert:

- an unknown handle returns `async_expired/unknown`, provider calls `0`;
- a handle claimed after `expiresAt` is persisted as `expired`, returns
  `async_expired/expired`, provider calls `0`;
- an exhausted inspection budget is persisted as `failed`, returns
  `async_expired/inspection_budget_exhausted`, provider calls `0`.

- [x] **Step 2: Prove red**

```powershell
npx vitest run src/__tests__/cost-router-state.test.ts
```

- [x] **Step 3: Implement local terminal outcomes**

Unknown returns from the locked cold-read without writing. Expired and
inspection-exhausted handles receive one terminal atomic mutation. None of
these paths imports or invokes provider code.

- [x] **Step 4: Final exact-tip verification**

```powershell
npx vitest run src/__tests__/state-root.test.ts src/__tests__/cost-router-state.test.ts
npx tsc --noEmit
git diff --check
git status --short
```

Expected: all focused tests pass, typecheck exits 0, diff check is clean, and
status contains only the M1D plan, fixture, state module, and state tests.

## Stop Rule

Stop immediately on permission/policy/capability denial, unexpected worktree
changes, or a child process that remains alive after its one action. Do not
retry through another model. Any need for live provider behavior becomes M2 or
M5 work, not M1D scope.
