# Atlas Voice Adapter (ADR-0010 Phase 1)

Local FastAPI sidecar for STT / VAD / TTS. **Not a brain** — no scheduler, no task authority.

## Runtime

- Python **3.12** venv at `adapters/voice/.venv` (host 3.14 untouched)
- Default bind: `127.0.0.1:8765`
- Env: `ATLAS_VOICE_URL`, `ATLAS_VOICE_HOST`, `ATLAS_VOICE_PORT`, `ATLAS_VOICE_CACHE`

## Engines

| Role | Model |
|------|--------|
| Primary STT | GigaAM-v3 CTC ONNX int8 |
| Fallback STT | faster-whisper `small` int8 |
| VAD | Silero VAD |
| TTS | Silero TTS package `v5_4_ru` (voice `xenia` default) |

## Start

```powershell
adapters\voice\.venv\Scripts\python.exe adapters\voice\serve.py
```

Warmup (downloads models on first run):

```powershell
curl -X POST http://127.0.0.1:8765/warmup -F engines=gigaam,vad,tts,whisper
```

## atlas-cli

```text
atlas voice health
atlas voice stt --file path.wav
atlas voice tts --text "..." --out out.wav
atlas voice warmup
```

## Acceptance

```powershell
$env:ATLAS_VOICE_URL='http://127.0.0.1:8765'
adapters\voice\.venv\Scripts\python.exe scripts\acceptance\capability-stack\run.py --lane voice --require-voice-pass --out docs\atlas-cto\receipts\voice-phase1-acceptance.json
```

O-cases (documents) are out of scope for Phase 1 Voice GO.
