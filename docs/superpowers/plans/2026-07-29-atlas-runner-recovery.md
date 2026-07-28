# Atlas Runner Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover orphaned runner work without trusting false closure claims, restore Fable→Sonnet execution, and prove stale-build plus liveness behavior.

**Architecture:** Keep recovered freshness and lease annotation design. Add top-level/subagent separation to global Fable hook, make runner-start policy directly testable, and prevent `runner status` from creating its own writer lease. Documentation reports source proof separately from later Task Scheduler cutover.

**Tech Stack:** Python 3 `unittest`, TypeScript 5, Vitest 2, Commander 12, Node.js 22, PowerShell.

## Global Constraints

- Do not create `ATLAS.next`.
- Do not touch `state/exec-graph/*`, `state/evidence/*`, `docs/atlas-cto/VOLAURA-LEARNING-ENGINE-HANDOFF-2026-07-25.md`, `.env`, `C:\Projects\ATLAS`, Railway, Telegram, worktrees, junctions, or credentials.
- Preserve every unrelated staged, unstaged, and untracked file.
- Fable top-level seat remains planner-only. Sonnet/general-purpose subagents must execute delegated commands.
- No Task Scheduler mutation in this stage. Runtime cutover remains later Atlas consolidation work.
- TDD required: new regression must fail for expected reason before production edit.
- LUNA/Sonnet implementers edit only named files and do not commit. Codex SOL owns independent verification and any scoped commit.

---

### Task 1: Stop Fable guard from blocking delegated subagents

**Files:**
- Modify: `C:\Users\user\.claude\hooks\fable-protocol-router.test.py`
- Modify: `C:\Users\user\.claude\hooks\fable-protocol-router.py`

**Interfaces:**
- Consumes: Claude hook common fields `agent_id` and `agent_type`; Fable session state stored by `session_id`.
- Produces: `is_subagent_tool_call(payload, state) -> bool`; top-level Fable enforcement unchanged.

- [ ] **Step 1: Write failing production-shaped tests**

Extend `start_fable_session` with optional `agent_type`. Extend `pre_tool` with optional `agent_id` and `agent_type`. Add:

```python
def test_sonnet_subagent_inside_fable_session_can_run_bash(self) -> None:
    self.start_fable_session()
    output = self.pre_tool(
        "Bash",
        {"command": "git status --porcelain"},
        agent_id="agent-sonnet-1",
        agent_type="general-purpose",
    )
    self.assertEqual(output, {})

def test_subagent_calls_do_not_consume_fable_read_budget(self) -> None:
    self.start_fable_session()
    for index in range(12):
        self.assertEqual(
            self.pre_tool(
                "Read",
                {"file_path": f"file-{index}.txt"},
                agent_id="agent-sonnet-1",
                agent_type="general-purpose",
            ),
            {},
        )
    self.assertEqual(self.pre_tool("Read", {"file_path": "README.md"}), {})

def test_top_level_agent_type_does_not_bypass_fable_guard(self) -> None:
    self.start_fable_session(agent_type="fable-orchestrator")
    output = self.pre_tool(
        "Bash",
        {"command": "npm run build"},
        agent_type="fable-orchestrator",
    )
    self.assertEqual(output["hookSpecificOutput"]["permissionDecision"], "deny")
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
python C:\Users\user\.claude\hooks\fable-protocol-router.test.py -v
```

Expected: existing 12 tests pass; new subagent regression fails because Bash is denied or read budget is consumed.

- [ ] **Step 3: Implement minimum child-call classifier**

Store top-level `agent_type` during `SessionStart`. Add:

```python
def is_subagent_tool_call(
    payload: dict[str, Any],
    state: dict[str, Any],
) -> bool:
    if str(payload.get("agent_id") or ""):
        return True
    agent_type = str(payload.get("agent_type") or "")
    if not agent_type:
        return False
    session_agent_type = str(state.get("session_agent_type") or "")
    return not session_agent_type or agent_type != session_agent_type
```

At start of `handle_pre_tool_use`, after `read_state` and before model/seat resolution:

```python
if is_subagent_tool_call(payload, state):
    return
```

This preserves top-level `Agent` rewrite to Sonnet because that call has no child `agent_id`; only tools already executing inside a child bypass planner limits.

- [ ] **Step 4: Run full hook suite and verify GREEN**

Run:

```powershell
python C:\Users\user\.claude\hooks\fable-protocol-router.test.py -v
```

Expected: all tests pass, including direct top-level Edit/Bash denial, Agent→Sonnet rewrite, fallback planner denial, and child Bash allowance.

- [ ] **Step 5: Self-review and report**

Report `DONE`, exact test command/output count, files changed, and concerns. Do not commit.

---

### Task 2: Close runner policy and status-lease gaps

**Files:**
- Modify: `src/__tests__/build-freshness.test.ts`
- Modify: `src/atlas/build-freshness.ts`
- Modify: `src/__tests__/m4-instance-lease.test.ts`
- Modify: `src/atlas/instance-lease.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `runnerStartAllowed(freshness: BuildFreshness, override: boolean): boolean`.
- Produces: `shouldAcquireInstanceLease(argv: readonly string[]): boolean`.
- `runner status` reads existing lease without acquiring or heartbeating a new lease.

- [ ] **Step 1: Write stale-start policy test**

Add to `build-freshness.test.ts`:

```typescript
describe('runnerStartAllowed', () => {
  it('refuses only stale builds without an explicit override', () => {
    const stale = compareBuildFreshness(
      stamp({ distMtimeMs: T0, newestSrcMtimeMs: T0 + HOUR }),
    );
    expect(runnerStartAllowed(stale, false)).toBe(false);
    expect(runnerStartAllowed(stale, true)).toBe(true);
    expect(runnerStartAllowed({ status: 'unknown', reason: 'synthetic' }, false)).toBe(true);
    expect(runnerStartAllowed(compareBuildFreshness(stamp()), false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run stale-start test and verify RED**

Run:

```powershell
npx vitest run src/__tests__/build-freshness.test.ts
```

Expected: FAIL because `runnerStartAllowed` is not exported.

- [ ] **Step 3: Implement and wire stale-start policy**

Add to `build-freshness.ts`:

```typescript
export function runnerStartAllowed(
  freshness: BuildFreshness,
  override: boolean,
): boolean {
  return freshness.status !== 'stale' || override;
}
```

Import it in the `runner start` action and use it for the refusal branch. Keep loud stale error and unsafe override warning unchanged.

- [ ] **Step 4: Write status lease-exemption tests**

Add to `m4-instance-lease.test.ts`:

```typescript
describe('CLI instance-lease routing', () => {
  it('does not let runner status create the lease it is trying to observe', () => {
    expect(shouldAcquireInstanceLease(['runner', 'status'])).toBe(false);
  });

  it('keeps writer protection for runner start and other commands', () => {
    expect(shouldAcquireInstanceLease(['runner', 'start'])).toBe(true);
    expect(shouldAcquireInstanceLease(['chat', 'hello'])).toBe(true);
  });
});
```

- [ ] **Step 5: Run lease test and verify RED**

Run:

```powershell
npx vitest run src/__tests__/m4-instance-lease.test.ts
```

Expected: FAIL because `shouldAcquireInstanceLease` is not exported.

- [ ] **Step 6: Implement and wire status lease exemption**

Add to `instance-lease.ts`:

```typescript
export function shouldAcquireInstanceLease(argv: readonly string[]): boolean {
  return !(argv[0] === 'runner' && argv[1] === 'status');
}
```

Import it in `cli.ts`. In executable-entry guard, call `acquireInstanceLease()` and start its heartbeat only when `shouldAcquireInstanceLease(process.argv.slice(2))` is true. Always keep `program.parse()` and exit wrapper active.

- [ ] **Step 7: Run focused runner suite**

Run:

```powershell
npx vitest run src/__tests__/build-freshness.test.ts src/__tests__/runner-liveness-lease.test.ts src/__tests__/atlas-runner.test.ts src/__tests__/m4-instance-lease.test.ts
npm run typecheck
```

Expected: exit 0, zero failed tests, zero TypeScript errors.

- [ ] **Step 8: Self-review and report**

Run `git diff --check` for five named files. Report `DONE`, RED/GREEN evidence, changed files, and concerns. Do not commit.

---

### Task 3: Remove false closure claims from recovered documentation

**Files:**
- Modify: `scripts/start-runner.cmd`
- Modify: `docs/atlas-cto/P0-MISSION-2026-07-27.md`
- Modify: `docs/runbooks/bootstrap.md`

**Interfaces:**
- Consumes: Task 2 focused-test and typecheck receipts.
- Produces: documentation distinguishing verified source patch from deferred Task Scheduler runtime cutover.

- [ ] **Step 1: Correct wrapper status wording**

Change `Registered as the Windows scheduled task "AtlasRunner"` to `Intended as the Windows scheduled task "AtlasRunner" wrapper`.

- [ ] **Step 2: Correct P0 mission closure**

Replace `Both defects above are CLOSED` and historic unverified suite totals with:

```markdown
Both source defects have a recovered, locally verified patch. Runtime closure
is still OPEN: the observed `AtlasRunner` scheduled task still invokes
`node dist\cli.js runner start --interval 20` directly. Switching it to the
wrapper and proving one live restart belongs to later authorized cutover.
```

Keep file-level design and test-file descriptions. State focused runner tests plus typecheck passed only after Task 2 receipts exist.

- [ ] **Step 3: Clarify bootstrap migration state**

Keep wrapper registration command as desired-state procedure. Add:

```markdown
Existing installations that still invoke `dist\cli.js` directly are not
migrated by this source change. Update the scheduled action only during the
authorized runtime cutover, then verify wrapper log plus `runner status`.
```

- [ ] **Step 4: Verify documentation claims**

Run:

```powershell
rg -n "CLOSED|995|1032|scheduled task now runs|Registered as the Windows" scripts/start-runner.cmd docs/atlas-cto/P0-MISSION-2026-07-27.md docs/runbooks/bootstrap.md
git diff --check -- scripts/start-runner.cmd docs/atlas-cto/P0-MISSION-2026-07-27.md docs/runbooks/bootstrap.md
```

Expected: no stale closure/totals/current-runtime claims; diff check exit 0.

- [ ] **Step 5: Self-review and report**

Report `DONE`, exact checks, files changed, and concerns. Do not commit.

---

### Task 4: Make runner identity and lease ownership fail closed

**Files:**
- Modify: `src/__tests__/atlas-runner.test.ts`
- Modify: `src/__tests__/runner-liveness-lease.test.ts`
- Modify: `src/atlas/atlas-runner.ts`
- Modify: `src/atlas/instance-lease.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- `RunnerAnnotation.kind?: 'runner'` distinguishes a runner from another Atlas
  process holding the shared instance lease.
- `annotateInstanceLease(instanceId, patch)` requires PID plus acquisition ID.
- `runner start` refuses to enter its loop unless self-declaration succeeds.

- [ ] Add RED tests for non-runner occupancy and wrong-instance annotation.
- [ ] Add runner marker and `occupied` non-success status.
- [ ] Require instance ID plus PID to annotate.
- [ ] Pass owned writer ID from CLI guard; fail before dependencies/loop when absent.
- [ ] Align unknown-build test wording and assertions.
- [ ] Run focused four-file suite, typecheck, scoped diff check, and report. No commit.
