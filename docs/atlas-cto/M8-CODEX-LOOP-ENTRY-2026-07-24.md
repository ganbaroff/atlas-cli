# M8 Codex-Loop Entry — Six Fields
**Date:** 2026-07-24  
**Branch:** `codex/m8-evidence-audit`

## 1. Shipped
- Typed claim schema (`src/evidence/claim.ts`) per SPEC-M8 §3
- Hash-chained JSONL ledger + snapshot (`src/evidence/ledger.ts`)
- Read-only auditor with adversarial log (`src/evidence/auditor.ts`)
- CLI `atlas evidence audit`
- §9 defaults: auditor via fixed CLI path (outside Hand registry); no evidence-append Hand verb; no FP decay

## 2. Proof
```
npm test -- --run src/__tests__/m8-evidence.test.ts → PASS
findingsCount >= 2 on fixture (stale + tampered)
```

## 3. Decisions
- Auditor has zero exec-graph authority (structural import ban)
- Stale = missing file path for file-exists/file-contains
- Tamper = entryHash/prevHash mismatch

## 4. Deferred
- Full verify() replay integration
- FP-registry JSONL
- HandSpec evidence-append debate (kept out of Hand registry)

## 5. Residual risk
- V0 stale rules are path-existence only
- Nested commander `evidence audit` UX may need polish

## 6. Commit hash + counts
- Tip: (fill)
