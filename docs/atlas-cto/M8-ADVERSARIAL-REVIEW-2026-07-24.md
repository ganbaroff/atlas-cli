# M8 Adversarial Review
**Verdict:** PASS-WITH-EXCEPTION  
**Date:** 2026-07-24

## §9 open questions — executor defaults
1. Auditor outside hierarchy → fixed CLI `evidence audit` (not Hand registry). ✓
2. No `evidence-append` Hand verb in V0 — append via ledger module only. ✓
3. No FP decay — permanent until explicit reverse (registry deferred). ✓

## Findings
| ID | Sev | Finding |
|----|-----|---------|
| M8-ADV-01 | MED | Stale detection limited to file path existence |
| M8-ADV-02 | LOW | FP-registry not implemented yet |

No HIGH blockers for V0 DoD (stale+tamper fixture + adversarial log).
