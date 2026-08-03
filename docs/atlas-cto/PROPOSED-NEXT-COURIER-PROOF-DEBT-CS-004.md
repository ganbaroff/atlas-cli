# Proposed next proof — Courier Loop on real Atlas task

**Status:** PROPOSED (awaiting CEO GO to start)  
**Capability:** `ATLAS COURIER LOOP v0`  
**Bound:** isolated ANUS worktree · ≤5 files · no production · 1 Cursor · 1 ChatGPT review · max 1 repair · spine-verifier · &lt;1h

## Task title

**DEBT-CS-004 — orphan effectProof negative coverage**

## Why this improves Atlas

Core Spine residual LOW debt: EvidencePack must reject effectProofs that cite missing/orphan refs. Strengthens independent verifier before wider courier use on real work.

## Allowed files (max 5)

1. `src/__tests__/core-spine.test.ts`  
2. `docs/atlas-cto/DEBT-2026-08-03-core-spine-low.md`  
3. `docs/atlas-cto/CHG-2026-08-03-debt-cs-004-orphan-proof.md` (new, if needed)  
4. `docs/atlas-cto/RECEIPT-2026-08-03-debt-cs-004.md` (new, after close)  
5. *(optional fifth)* `src/core-spine/evidence-pack-contract.ts` only if a contract gap is proven

## Forbidden

- No VOLAURA/Integronix/production mutation  
- No runners/daemon/Telegram/push/deploy  
- No `--force` on Cursor hand  
- No second repair cycle  

## Success

- New negatives fail closed for orphan/missing effectProof refs  
- Focused + full meaningful vitest green  
- ChatGPT review ACCEPT or one bounded REPAIR  
- Independent spine-verifier PASS  
- CEO receipt  

## Rollback

`git revert` of the proof branch merge commit on the worktree tip.
