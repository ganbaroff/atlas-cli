# ADR-0010 — Capability stack: Voice (Phase 1) + Documents (Phase 2)

- **Status:** ACCEPTED
- **Date:** 2026-08-05
- **Deciders:** Orchestrator audit 2026-08-05 (recorded into ANUS canon); CEO may veto by line
- **Homes:** This file (`docs/atlas-cto/`). Numbered twin: `docs/adr/0010-capability-stack-voice-and-documents.md`
- **Supersedes / binds:** ADR-0009 A1.4 (ANUS = decision canon); ADR-018 (no autonomous daemon); master-plan VOICE-01 intent; no Cost Router resume

## Context

Orchestrator capability audit (2026-08-05) found **10 of 12** Atlas lanes already covered by existing ANUS code + Claude MCPs. Adding frameworks for covered lanes creates fork risk and disk/VRAM waste on the CEO machine (RTX 5060 8GB, ~29GB free disk).

Two gaps remain product-relevant:

1. **VOICE** — CEO morning report in Russian (STT in / TTS out), not a second brain.
2. **DOCUMENTS** — OCR + table structure for RU/AZ/EN paperwork, not a new agent runtime.

## Decision

### Do not build

Do **not** add frameworks for the 10 already-covered lanes. Reuse ANUS + MCPs.

**Explicitly rejected (do not revisit without CEO):**

| Option | Reason |
|--------|--------|
| LiveKit Agents | Wrong shape (realtime agent framework ≠ adapter) |
| XTTS | CPML license unfit |
| Kokoro | No Russian |
| EasyOCR | AZ diacritics bug (#357) |
| OmniParser | Already covered elsewhere |
| dots.ocr / olmOCR-2 | VRAM > 8GB |

### Phase 1 — VOICE

**Acceptance north star:** morning report, Russian.

| Role | Choice |
|------|--------|
| Primary STT | **GigaAM-v3 ONNX int8** (MIT) |
| Fallback STT | **faster-whisper int8** |
| VAD | **Silero VAD** |
| TTS | **Silero TTS `v5_4_ru`** |
| UX | **Push-to-talk first**; wake word **later** |
| Adapter | Local **Python FastAPI** server called from **atlas-cli** |
| Adapter law | **No own scheduler, no own brain**, no second task authority |
| Cloud fallback (non-sensitive only) | **NVIDIA Riva/NIM → Azure Speech F0** |

Sensitive audio stays local. Cloud path requires explicit non-sensitive classification; never default.

### Phase 2 — DOCUMENTS

| Role | Choice |
|------|--------|
| Primary OCR-VL | **PaddleOCR-VL 1.6** via **HF Transformers** backend |
| Runtime | **Python 3.12 venv** (3.14 wheels lag — do not target 3.14) |
| Tables | **PP-StructureV3** |
| CPU fallback | **Tesseract** `rus` + `aze` + `eng` |
| Adapter | Same pattern as Voice: FastAPI sidecar, atlas-cli client, no brain |

### Budget & hardware

- Disk target: **~5GB total** for Voice + Documents model/runtime assets (machine had ~29GB free at decision time — re-check before download).
- Watch **VRAM contention**: Voice + OCR on **RTX 5060 8GB** must not double-load without an explicit gate (fail closed or serialise).

### Closure rule

Nothing in Voice/Documents is **"done"** until the acceptance scripts under `scripts/acceptance/capability-stack/` report **PASS** (not UNTESTED). See companion harness.

## Consequences

- Implementation order: (1) ADR + acceptance scripts (this commit) → (2) FastAPI adapter stubs → (3) model install within disk budget → (4) atlas-cli HTTP client → (5) morning-report path → (6) OCR path. Each step needs evidence.
- No LiveKit/XTTS/Kokoro/EasyOCR/OmniParser/dots/olm experiments in-tree.
- No new daemon or scheduler for speech/OCR.
- Planning/execute layers remain separate; this ADR does not authorize production deploy or unattended loops.

## References

- Orchestrator decision text 2026-08-05 (this ADR records it)
- `docs/atlas-cto/ATLAS-MASTER-PLAN.md` (VOICE-01)
- `docs/adr/0009-vision-canon-portable-agent-factory.md`
- Acceptance harness: `scripts/acceptance/capability-stack/`
