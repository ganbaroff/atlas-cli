# Capability-stack acceptance harness (ADR-0010)

**Status of all cases:** `UNTESTED` until adapters + fixtures exist and this runner prints `PASS`.

Do **not** claim Voice/Documents "done" while any required case is `UNTESTED` or `FAIL`.

## Run

```bash
# From ANUS repo root:
python scripts/acceptance/capability-stack/run.py
python scripts/acceptance/capability-stack/run.py --json
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | All required cases PASS |
| 1 | At least one FAIL |
| 2 | No FAIL, but at least one UNTESTED / SKIP (default today) |
| 3 | Harness misconfiguration |

## Cases

See `cases.json` (10 voice + 8 OCR). Criteria come from orchestrator audit 2026-08-05 / ADR-0010.
