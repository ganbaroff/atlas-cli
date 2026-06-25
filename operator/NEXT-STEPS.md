# Operator Integration Status

## Current State

First slice is real and executable.

- task/result/evidence schemas exist
- run-ledger writer exists
- sandbox-required OpenManus tasks are blocked before launch when runtime config disables sandbox
- explicit local read-only HTTP smoke can produce promoted PASSED ledger entries
- explicit local read-only file smoke can produce promoted PASSED ledger entries without storing file body
- action task ids include milliseconds to avoid same-second result overwrite
- operator state exists
- control plane exists
- first OpenManus smoke task exists
- Atlas CLI can validate, dispatch, run lifecycle, and intake explicit operator actions
- brain planner now feeds CLI / Telegram / API from one prompt path
- OpenManus adapter launches through `C:/Projects/OpenManus/.venv/Scripts/python.exe`
- fake success is blocked by evidence gate
- OpenManus local smoke previously passed; sandbox-required tasks now refuse local fallback
- Octogent scaffold smoke passed
- Vellum gate smoke passed
- Octogent child-agent smoke passed
- Octogent inter-agent message smoke passed
- Octogent todo swarm smoke passed
- Octogent worktree smoke passed
- Octogent parent swarm loop smoke passed
- Octogent channel delivery smoke passed
- Octogent live child-ack smoke passed
- OpenManus browser trace proof passed
- Result quality evaluator smoke passed
- Result promotion smoke passed
- End-to-end lifecycle smoke passed
- Action-lane local HTTP smoke passed
- Action-lane local file smoke passed

## Current Blocker

OpenManus body not ready for promoted action-lane pass.

Reason: `C:/Projects/OpenManus/config/config.toml` currently has `[sandbox] use_sandbox = false`, while operator OpenManus tasks require `safety.sandbox_required=true`. Dispatcher now blocks this mismatch before launch instead of falling back to local `main.py`.

Completed proof: `/operator local-smoke https://example.com "Example Domain"` passes through task -> dispatch -> evaluation -> promotion -> ledger without OpenManus.

Completed proof: `/operator file-smoke README.md Atlas` passes through task -> dispatch -> evaluation -> promotion -> ledger. Adversarial control with missing text blocks. Evidence stores file hashes/metadata, not file body.

Remaining gaps:

- OpenManus sandbox must be made real before `/operator smoke ...` can pass.
- Broad natural-language user intent still needs policy-gated compilation beyond explicit smoke commands.

## Commands

```powershell
npm run dev -- control validate
npm run dev -- operator status
npm run dev -- operator validate operator/tasks/octogent-live-child-ack-smoke.json
npm run dev -- operator dispatch operator/tasks/octogent-live-child-ack-smoke.json
npm run dev -- operator lifecycle operator/tasks/octogent-live-child-ack-smoke.json
npm run dev -- operator validate operator/tasks/result-promotion-smoke.json
npm run dev -- operator dispatch operator/tasks/result-promotion-smoke.json
npm run dev -- operator dispatch operator/tasks/openmanus-smoke-readonly.json
npm run dev -- operator intake /operator smoke https://example.com "Example Domain"
npm run dev -- operator intake /operator local-smoke https://example.com "Example Domain"
npm run dev -- operator intake /operator file-smoke README.md Atlas
```

## Latest Durable Proof

`operator/runs/octogent-live-child-ack-smoke.lifecycle.result.json`

Lifecycle chain:

- dispatch: `operator/runs/octogent-live-child-ack-smoke.result.json`
- evaluation: `operator/runs/octogent-live-child-ack-smoke-life-eval.result.json`
- promotion: `operator/runs/octogent-live-child-ack-smoke-life-prom.result.json`
- final: `promotion.status=promoted`, `lifecycle.final_status=success`

## Next Physical Step

OpenManus sandbox readiness.

Reason: explicit local HTTP/file smokes can now pass honestly. Next missing body part is a real sandboxed OpenManus body that can produce promoted browser evidence without local fallback.

Proofs already exist:

- `browser_observation`
- `browser_session_trace`
- `command_exit`
- `log_trace`
- `manual_note`
- `proof_tokens`
- `evaluation.final_verdict`
- `promotion.status`
