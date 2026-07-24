# M9 Adversarial Review
**Verdict:** PASS-WITH-EXCEPTION  
**Date:** 2026-07-24

## Findings
| ID | Sev | Finding |
|----|-----|---------|
| M9-ADV-01 | MED | Shared exchange dir is trust boundary — FS attacker can inject requests |
| M9-ADV-02 | LOW | In-memory `seen` set resets on process restart; disk receipt still dedupes |

No HIGH. No product state copied across repos.
