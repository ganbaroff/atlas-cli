# Cursor Handoff

> Standing end-of-session ritual. Replaced each session. Cursor seat.

## 1. Date, branch, HEAD

- Date: 2026-08-05
- Branch: `codex/atlas-cost-router-design`
- HEAD before this handoff commit:

```
$ git log -1 --oneline
803f41e feat(voice): Ship ADR-0010 Phase 1 FastAPI adapter with V01-V10 PASS
```


## 2. What changed this session — files + one line each

- `adapters/voice/` — Python 3.12 FastAPI sidecar (GigaAM-v3 ONNX int8, faster-whisper int8, Silero VAD, Silero TTS `v5_4_ru` / voice `xenia`); no brain/scheduler
- `adapters/voice/.venv/` — local 3.12.10 venv (gitignored); host Python 3.14 untouched
- `src/atlas/voice-adapter-client.ts` — HTTP client for atlas-cli
- `src/cli.ts` — `atlas voice health|stt|tts|warmup`
- `scripts/acceptance/capability-stack/run.py` — live V01–V10 probes; `--lane voice --require-voice-pass`
- `scripts/acceptance/capability-stack/cases.json` — V01–V10 marked PASS; O* still UNTESTED
- `docs/atlas-cto/receipts/voice-phase1-acceptance-2026-08-05.json` — real harness receipt (10 PASS)
- `docs/atlas-cto/receipts/disk-free-2026-08-05.txt` — disk free after installs (~44.2 GB)

## 3. Receipts — real output

```
$ adapters\voice\.venv\Scripts\python.exe -c "import sys; print(sys.version)"
3.12.10 ...

$ POST /warmup
{"ok":true,"loaded":{"gigaam":true,"whisper":true,"vad":true,"tts":true},"peakRssMb":1006.75}

$ run.py --lane voice --require-voice-pass
ADR-0010 capability acceptance - {'PASS': 10, 'FAIL': 0, 'UNTESTED': 0, 'SKIP': 0}
  [PASS] V01 ... V10
exitCode=0
```

Disk: CEO GO cited 47.6 GB free; after model install ~44.2 GB free (see receipts).

## 4. Risks / broken things you know about

- V10 measured **CPU RSS ~1.0 GB**, not CUDA VRAM — torch CPU wheels; RTX 5060 VRAM gate still needs GPU run when CUDA torch available
- GigaAM drop "Atlas" token on morning fixture (still ≥3 expected tokens) — CER threshold not formalized
- Silero TTS hub package `v5_4_ru` exposes voices `aidar|baya|kseniya|xenia` (not the package id as apply_tts speaker)
- Documents Phase 2 / O01–O08 **not started**
- Adapter must be running on `:8765` for CLI/harness
- OneDrive path + Cursor workspace root mismatch can hide uncommitted files — verify `adapters/voice/*.py` on disk before restart

## 5. Next 3 steps

1. Optional: CUDA torch + re-run V10 with peak VRAM evidence on RTX 5060 8GB
2. Wire Telegram / morning-report path to call adapter (still no second brain)
3. Phase 2 Documents GO only when CEO authorizes O-cases (PaddleOCR-VL 1.6 on separate 3.12 venv)

## 6. Blockers that need CEO or the orchestrator chat

- None for Phase 1 Voice GO closure — V01–V10 PASS
- Authorize Phase 2 Documents when ready
- Decide whether cloud Riva/NIM / Azure F0 credentials get wired (policy endpoint only today)
