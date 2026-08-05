# Cursor Handoff

> Standing end-of-session ritual. Replaced each session. Cursor seat.

## 1. Date, branch, HEAD

- Date: 2026-08-05
- Branch: `codex/atlas-cost-router-design`
- HEAD before this handoff commit:

```
$ git log -1 --oneline
988ab88 feat(documents): Ship ADR-0010 Phase 2 adapter with O01-O08 PASS
```


## 2. What changed this session — files + one line each

- `adapters/documents/` — Python 3.12 FastAPI sidecar: PaddleOCR-VL 1.6 (HF Transformers), PP-StructureV3 (paddlex), Tesseract `rus+aze+eng`; unload-between-engines; `/vram-gate` fail-closed
- `adapters/documents/.venv/` — local 3.12.10 venv (gitignored); host 3.14 untouched
- `adapters/voice/app.py` — TTS robustness: Latin-only → 400 JSON; global exception handler + traceback logging; speaker alias; version `0.1.1`
- `src/atlas/docs-adapter-client.ts` — HTTP client for atlas-cli
- `src/cli.ts` — `atlas docs health|ocr|warmup`
- `scripts/acceptance/capability-stack/run.py` — live O01–O08 probes; `--lane documents --require-docs-pass`
- `scripts/acceptance/capability-stack/cases.json` — O01–O08 marked PASS (V* already PASS)
- `docs/atlas-cto/receipts/docs-phase2-acceptance-2026-08-05.json` — real harness receipt (8 PASS, exit 0)
- `docs/atlas-cto/receipts/tts-error-logging-2026-08-05.json` — Latin 400 / RU 200 multipart outside harness
- `docs/atlas-cto/receipts/disk-budget-override-phase2-2026-08-05.md` — O07 measured 6.44GB; CEO override token

## 3. Receipts — real output

```
$ run.py --lane documents --require-docs-pass
ADR-0010 capability acceptance - {'PASS': 8, 'FAIL': 0, 'UNTESTED': 0, 'SKIP': 0}
  [PASS] O01 … O08
exitCode=0

$ POST /tts text=Hello world   → 400 {"detail":"silero v5_4_ru requires Cyrillic Russian text; Latin-only input rejected"}
$ POST /tts text=Доброе утро    → 200 wav ~91KB
```

Start adapters detached (Cursor shell job tree kills uvicorn if started as foreground child):

```
Start-Process …\adapters\voice\.venv\Scripts\python.exe -ArgumentList '-u','serve.py' -WorkingDirectory …\adapters\voice -WindowStyle Hidden
# docs: set ATLAS_OCR_ALLOW_WITH_VOICE=1 TESSDATA_PREFIX=…\adapters\documents\tessdata
```

## 4. Risks / broken things you know about

- Disk budget now **6.44GB** (docs_cache grew; HF + paddlex). O07 PASS via CEO override receipt — not ≤5GB raw
- CPU VL inference **minutes/image**; Structure first load ~1–2 min; unload VL↔Structure to avoid RAM thrash (~5–6GB RSS)
- O05 after O03 reloads VL then often falls to tesseract — slow; prefer `engine=fallback` for AZ-only probes later
- Cursor-integrated Shell kills background `serve.py` ~30s — use **Start-Process -WindowStyle Hidden**
- TTS still rejects Latin-only by design (Silero `v5_4_ru`); clients must send Cyrillic or handle 400
- V10 still CPU RSS not CUDA VRAM
- OneDrive path vs Cursor `C:\Projects\ATLAS` workspace mismatch — verify ANUS canon path before restart

## 5. Next 3 steps

1. Wire Telegram / morning-report + document OCR path through adapters (still no second brain)
2. Optional: CUDA torch; measure real VRAM for V10/O08 on RTX 5060 8GB
3. Trim docs disk (dedupe HF snapshots / paddlex cache) or keep override as standing policy

## 6. Blockers that need CEO or the orchestrator chat

- None for Phase 2 Documents GO closure — O01–O08 PASS
- Confirm standing OK on 6.44GB disk (override already written) vs prune cache back under 5GB
- Decide cloud Riva/NIM / Azure F0 credential wiring (policy endpoint only today)
