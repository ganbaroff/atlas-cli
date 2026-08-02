# Core Execution Spine — contracts

Markdown-first companion to `src/core-spine/*`.

## Modules

| Module | Role |
|---|---|
| `executor-adapter-contract.ts` | Normalized future-hand adapter contract (no Hermes/Cursor/Codex impl yet) |
| `project-agent-contract.ts` | Project boundary; `personalMemoryWrite` locked to `prohibited` |
| `evidence-pack-contract.ts` | `goal→…→receipt` evidence shape |
| `lifecycle-binding.ts` | Maps spine stages → existing exec-graph statuses |
| `spine-verifier.ts` | Fail-closed invariants (no LLM) |

## Authority

Atlas/ANUS remains sole brain. These contracts do **not** create a second task graph or router.
