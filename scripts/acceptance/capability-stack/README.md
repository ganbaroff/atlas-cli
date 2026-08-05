# Capability-stack acceptance harness (ADR-0010)

## Phase 1 Voice (2026-08-05)

V01–V10 **PASS** against live FastAPI adapter. Receipt:

`docs/atlas-cto/receipts/voice-phase1-acceptance-2026-08-05.json`

## Phase 2 Documents (2026-08-05)

O01–O08 **PASS** against live documents adapter (`:8766`). Receipt:

`docs/atlas-cto/receipts/docs-phase2-acceptance-2026-08-05.json`

TTS robustness (Latin → 400 JSON, not bare 500):

`docs/atlas-cto/receipts/tts-error-logging-2026-08-05.json`

## Run

```powershell
# Start adapters (prefer Start-Process -WindowStyle Hidden — Cursor shells kill children):
adapters\voice\.venv\Scripts\python.exe adapters\voice\serve.py
# docs:
$env:ATLAS_OCR_ALLOW_WITH_VOICE='1'
$env:TESSDATA_PREFIX=(Resolve-Path adapters\documents\tessdata)
adapters\documents\.venv\Scripts\python.exe adapters\documents\serve.py

# Voice lane:
$env:ATLAS_VOICE_URL='http://127.0.0.1:8765'
adapters\voice\.venv\Scripts\python.exe scripts\acceptance\capability-stack\run.py --lane voice --require-voice-pass --out docs\atlas-cto\receipts\voice-phase1-acceptance.json

# Documents lane:
$env:ATLAS_DOCS_URL='http://127.0.0.1:8766'
adapters\documents\.venv\Scripts\python.exe -u scripts\acceptance\capability-stack\run.py --lane documents --require-docs-pass --out docs\atlas-cto\receipts\docs-phase2-acceptance.json

# Full ledger (voice + documents):
python scripts/acceptance/capability-stack/run.py
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | All selected cases PASS |
| 1 | At least one FAIL |
| 2 | No FAIL, but at least one UNTESTED / SKIP |
| 3 | Harness misconfiguration |

## Cases

See `cases.json` (10 voice + 8 OCR). Criteria from ADR-0010.
