# CHG-2026-08-03 — Atlas Courier Loop v0

**Status:** CLOSED — CEO ACCEPT 2026-08-03  
**Capability ID:** `ATLAS COURIER LOOP v0`  
**Proof ID:** `proof_2026_08_03_atlas_courier_replacement`  
**Decision:** `VOLAURA/memory/atlas/decisions/ATLAS-AUTONOMOUS-COURIER-LOOP-DECISION-2026-08-03.md`  
**CEO proof receipt:** `VOLAURA/memory/atlas/ceo-feed/ATLAS-COURIER-REPLACEMENT-PROOF-COMPLETE-2026-08-03.md`

## Change

Add two replaceable hands + thin courier orchestrator that reuses Core Spine (EvidencePack, effectProofs, spine-verifier). No second task graph, daemon, or general desktop autonomy.

| Path | Role |
|---|---|
| `src/hands/cursor-headless-adapter.ts` | `adapter.cursor-headless` |
| `src/hands/chatgpt-browser-reviewer-adapter.ts` | `adapter.chatgpt-browser-reviewer` |
| `src/hands/manifests/cursor-headless.json` | HandSpec |
| `src/hands/manifests/chatgpt-browser-reviewer.json` | HandSpec |
| `src/courier/courier-loop.ts` | Bounded orchestrator |
| `src/__tests__/courier-loop-negatives.test.ts` | Fail-closed negatives + mock repair |
| `scripts/run-courier-proof.ts` | Resume runner |
| `scripts/run-courier-final-review.ts` | Review+verify helper |

## Explicit non-goals

- No background daemon / Task Scheduler enablement  
- No unrestricted desktop control  
- No `--force` / `--yolo` in courier path  
- No Hermes/OpenManus/Codex as participants in this capability  
- Quarantine evidence stays outside git (`~\.atlas\quarantine\…`)

## Closure

Merged after disposable proof green (Cursor → evidence → ChatGPT Comet ACCEPT → spine-verifier).  
Yusif courier copy/paste after auth: none.
