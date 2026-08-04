# Capability-stack acceptance harness (ADR-0010)

## Phase 1 Voice (2026-08-05)

V01–V10 **PASS** against live FastAPI adapter. Receipt:

`docs/atlas-cto/receipts/voice-phase1-acceptance-2026-08-05.json`

O01–O08 remain **UNTESTED** (Phase 2 Documents — not in Voice GO).

## Run

```powershell
# Start adapter first:
adapters\voice\.venv\Scripts\python.exe adapters\voice\serve.py

# Voice lane only (Phase 1):
$env:ATLAS_VOICE_URL='http://127.0.0.1:8765'
adapters\voice\.venv\Scripts\python.exe scripts\acceptance\capability-stack\run.py --lane voice --require-voice-pass --out docs\atlas-cto\receipts\voice-phase1-acceptance.json

# Full ledger (voice + documents):
python scripts/acceptance/capability-stack/run.py
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | All selected cases PASS (with `--require-voice-pass` + `--lane voice`: V01–V10 only) |
| 1 | At least one FAIL |
| 2 | No FAIL, but at least one UNTESTED / SKIP |
| 3 | Harness misconfiguration |

## Cases

See `cases.json` (10 voice + 8 OCR). Criteria from ADR-0010.
