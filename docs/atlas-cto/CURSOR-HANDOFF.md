# Cursor Handoff

> Standing end-of-session ritual. Replaced each session. Cursor seat.

## 1. Date, branch, HEAD

- Date: 2026-08-05
- Branch: `codex/atlas-cost-router-design`
- HEAD before this handoff commit:

```
$ git log -1 --oneline
dcaf9a6 fix(documents): Keep health live during OCR and refresh Phase 2 receipt
```

Prior feat: `988ab88 feat(documents): Ship ADR-0010 Phase 2 adapter with O01-O08 PASS`

## 2. What changed this session — files + one line each

- `adapters/documents/` — Python 3.12 FastAPI sidecar: PaddleOCR-VL 1.6 (HF Transformers), PP-StructureV3 (paddlex), Tesseract `rus+aze+eng`; unload-between-engines; heavy work in thread pool so `/health` stays live
- `adapters/documents/.venv/` — local 3.12.10 venv (gitignored); host 3.14 untouched
- `src/atlas/docs-adapter-client.ts` — HTTP client for atlas-cli
- `src/cli.ts` — `atlas docs health|ocr|warmup`
- `adapters/voice/app.py` — `/tts` robustness: global JSON exception handler + traceback; Latin-only → **400** before Silero load; Silero `ValueError` → 400; speaker=voice-id alias
- `scripts/acceptance/capability-stack/run.py` — live O01–O08; O05 uses tesseract fallback (not VL); O08 auto-warms voice; per-case progress logs; docs HTTP timeout 1800s
- `scripts/acceptance/capability-stack/cases.json` — O01–O08 marked PASS
- Receipts under `docs/atlas-cto/receipts/`:
  - `docs-phase2-acceptance-2026-08-05.json` — **8 PASS / exit 0**
  - `disk-budget-override-phase2-2026-08-05.md` — measured ~6.44GB >5GB; CEO Phase 2 GO override
  - `tts-robustness-2026-08-05.json` / `tts-error-logging-2026-08-05.json` — Latin 400 + RU 200

## 3. Receipts — real output

```
$ adapters\documents\.venv\Scripts\python.exe -u scripts\acceptance\capability-stack\run.py --lane documents --require-docs-pass
ADR-0010 capability acceptance - {'PASS': 8, 'FAIL': 0, 'UNTESTED': 0, 'SKIP': 0}
  [PASS] O01 … O08
exitCode=0

$ POST /tts text=Hello world  → 400 JSON (requires Cyrillic)
$ POST /tts text=Доброе утро → 200 audio/wav (~91KB)
```

## 4. Risks / broken things you know about

- CPU VL inference slow (minutes cold); pre-warm `/warmup engines=vl` before O02
- Sync uvicorn used to block `/health` during VL — fixed via `ThreadPoolExecutor` (v0.1.1); still only one heavy job at a time
- Cursor background shells can kill child uvicorn — start adapters with detached `Start-Process` / `cmd /c`
- Disk Voice+Docs caches measured **~6.44GB** (HF revision churn); override receipt present
- Torch+Paddle Windows: after paddle install, force-reinstall torch CPU; `numpy<2.4` for paddlex
- Fixtures must use Arial (or similar) — default PIL bitmap font mangles RU/AZ glyphs
- O05 intentionally tesseract path (EasyOCR #357 guard); VL not required for AZ diacritics case
- Voice+Docs both loaded: set `ATLAS_OCR_ALLOW_WITH_VOICE=1` for functional OCR; O08 still fail-closed when `strict=true`

## 5. Next 3 steps

1. ~~Wire Telegram / morning-report + document ingest to call adapters~~ — **voice + photo OCR wired** (`telegram-capability.ts`); morning briefing still text-only
2. Optional: CUDA torch + real VRAM evidence for V10/O08 on RTX 5060 8GB
3. Deduplicate HF cache revisions if reclaiming disk toward ≤5GB without override

## 6. Blockers that need CEO or the orchestrator chat

- None for Phase 2 Documents GO closure — O01–O08 PASS + TTS robustness fixed
- Decide cloud Riva/NIM / Azure F0 credential wiring (policy endpoint only today)
