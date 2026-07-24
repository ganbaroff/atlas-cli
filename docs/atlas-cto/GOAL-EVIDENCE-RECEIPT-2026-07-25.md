# Goal Evidence Write-back Receipt — Sprint E
_Date: 2026-07-25 · Verdict: PASS_

## Goal
Terminal goal status appends typed claim to M8 hash-chained ledger; fail-open on ledger errors.

## Implementation
- [`src/goal-runner/evidence-writeback.ts`](../src/goal-runner/evidence-writeback.ts) — `writeGoalTerminalClaim()`
- Hook in [`src/goal-runner/runner.ts`](../src/goal-runner/runner.ts) before return
- Claim: `narrative` type, confidence 0, JSON payload `{ kind: 'goal-terminal', goalId, status, handId, ... }`

## Tests
- `src/__tests__/m5-goal-evidence-writeback.test.ts` — append + chain verify + fail-open on broken chain

## CLI audit
After fixture goal with `ATLAS_EVIDENCE_DIR` set:
```
node dist/cli.js evidence audit --ledger <dir>
```

## Five-sprint stack CLOSED
Sprints A–E complete on `main`. Next parked: G-ATLAS-USER, Railway redeploy, VOLAURA codex-loop append.
