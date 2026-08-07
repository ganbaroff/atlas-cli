# Executor mission — continuation handoff

Written 2026-08-07 at ~86% context, per the execution order's context-discipline
rule. A fresh session starts here and needs no other history.

## Read these two files first, in this order

1. `docs/atlas-cto/EXECUTOR-MISSION-STATE.json` — every wave, its status, its
   receipts, and `nextAtomicStep`. This is the authority; this handoff is a
   summary of it.
2. `docs/atlas-cto/ANUS-TEST-BASELINE.json` — what the repo measures on this
   host. **Read it before blaming yourself for a red suite.**

Do not re-run the research. Do not re-open the framework comparison. Waves 1-3
and the executor choice are frozen.

## Where things stand in one paragraph

Atlas has a complete, tested autonomous coding loop: CEO goal → signed Work
Order → RepoWriterLease → Atlas-owned tool broker → ClineExecutorAdapter →
tests → deterministic verifier → evidence → bounded repair → rollback. Eleven of
twelve waves are DONE with live receipts. Wave 12, the final product proof, is
`BLOCKED_EXTERNAL`: every free model lane on this machine proxies through the
Google API, which fails multi-turn tool calling because the Cline SDK sends no
`thought_signature`; the credited NVIDIA lane does not respond; the only
non-Google lane (cerebras) is correctly refused as paid. **Nothing in Atlas
failed and no Cline contract failed in any of the five final attempts.**

## The exact blocker, so it is not re-diagnosed

```
Google API error 400: Function call is missing a thought_signature in
functionCall parts. This is required for tools to work correctly.
```

The first tool call lands; the turn after the tool result always dies. Fixture
missions passed because they fit in one or two turns. Real-file missions need
several, so they always fail. `gemma-4-31b-it` was tried specifically because
Gemma is not Gemini and produced the identical error — the gateway proxies
everything through Google, so the whole free lane is dead for this, not just its
Gemini models.

Two dead ends already checked, do not repeat them:
- Splitting the mission into single-turn steps does not help: the error occurs
  after the FIRST tool result, and an agent must return a tool result to the
  model by definition.
- Patching the Cline SDK is refused on principle. It is replaceable hands; a
  fork destroys the entire reason `ExecutorAdapter` exists.

## What unblocks it — CEO decision, not a technical one

Either:
- **(a)** CEO sets `ATLAS_ALLOW_PAID` and names a spend ceiling. Then rerun
  `src/__tests__/live/executor-live-final.test.ts` with
  `FINAL_PROVIDER=cerebras FINAL_MODEL=gpt-oss-120b`. The lane is already in
  `PROVIDER_REGISTRY`, the machinery is wired, it is one command.
- **(b)** A free non-Google OpenAI-compatible endpoint is supplied and added to
  `PROVIDER_REGISTRY`.

**Do not weaken the spend gate to unblock this.** The gate refusing cerebras is
the gate working.

## What NOT to treat as blockers

Stale boards, the 460 AZN debt, untriaged old reviews, the three pre-existing
typecheck errors, the three pre-existing `npx tsup` test failures, missing
documentation.

## Branch and commits

Branch `codex/cline-executor-adapter`, nothing pushed, nothing merged.

| commit | what |
|---|---|
| `58f92b0` | ExecutorAdapter boundary + Atlas tool broker |
| `6333cfd` | provider authority — no approved spend, no model call |
| `27d1f8c` | state-writer classification, repo baseline, waves 1-3 frozen |
| `4ed3934` | ClineExecutorAdapter behind the boundary |
| `f49bdc8` | first live mission — CEO goal to working code |
| `a36667f` | bounded repair with a planted-failure proof |
| `ac27401` `94e423a` | rollback, then the live rollback gap closed |
| `01bd38b` | production PANIC — real process-tree termination |
| `d604cca` | worktree-escaping command forms refused |
| `d656cb4` | durable mission record + real crash/restart proof |
| `4632b77` | first live mission against ANUS itself |
| `fcc886e` | repo-scale search and Python classes |
| `0ff6fc2` | ranged `read_file`; final blocker root-caused |
| `9e4b9b8` | cerebras lane + a real spend-gate gap closed |
| `d7700a2` | test baseline refreshed |

## Live tests — run deliberately, never in the suite

Under `src/__tests__/live/`. Each calls a real model, costs quota, and its
verdict depends on the executor rather than this repo. They are excluded from
the baseline command for that reason.

## Housekeeping left undone on purpose

Two mission worktrees remain under `ANUS/.worktrees/`:
`atlas-mission-courier-ts2367` and `atlas-mission-git-timeout`. They are Wave 10
and Wave 12 evidence. Removing a worktree is a destructive git operation and the
project's red lines require CEO sign-off, so they stay.
