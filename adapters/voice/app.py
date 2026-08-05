"""Atlas Voice adapter — FastAPI sidecar (ADR-0010 Phase 1).

No scheduler. No brain. No exec-graph writes. Called by atlas-cli over HTTP.
"""

from __future__ import annotations

import io
import logging
import os
import re
import tempfile
import time
import traceback
import wave
from pathlib import Path
from typing import Any, Literal

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

APP_NAME = "atlas-voice-adapter"
APP_VERSION = "0.1.2"
CACHE_DIR = Path(os.environ.get("ATLAS_VOICE_CACHE", Path(__file__).resolve().parent / ".cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
LOG = logging.getLogger("atlas.voice")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    description="Local STT/VAD/TTS adapter for atlas-cli. Not a brain.",
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Never return bare Starlette 500 text — log traceback + JSON detail."""
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    tb = traceback.format_exc()
    LOG.error("unhandled %s %s\n%s", request.method, request.url.path, tb)
    return JSONResponse(
        status_code=500,
        content={
            "ok": False,
            "error": type(exc).__name__,
            "detail": str(exc) or repr(exc),
            "path": request.url.path,
            "traceback": tb.splitlines()[-12:],
        },
    )

_gigaam = None
_whisper = None
_vad_model = None
_tts_model = None
_tts_sample_rate = 48000
_tts_voices: list[str] = []
_load_errors: dict[str, str] = {}
_peak_rss_mb = 0.0
SILERO_MODEL_SPEAKER = "v5_4_ru"
SILERO_DEFAULT_VOICE = "xenia"


def _rss_mb() -> float:
    try:
        import psutil

        return psutil.Process().memory_info().rss / (1024 * 1024)
    except Exception:
        return 0.0


def _track_rss() -> None:
    global _peak_rss_mb
    cur = _rss_mb()
    if cur > _peak_rss_mb:
        _peak_rss_mb = cur


def _read_audio_mono_16k(data: bytes) -> tuple[np.ndarray, int]:
    """Decode WAV/OGG/FLAC (libsndfile) and resample to mono 16 kHz."""
    audio, sr = sf.read(io.BytesIO(data), always_2d=False)
    if getattr(audio, "ndim", 1) > 1:
        audio = np.mean(audio, axis=1)
    audio = audio.astype(np.float32)
    if sr != 16000:
        duration = len(audio) / float(sr)
        new_len = max(1, int(duration * 16000))
        x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=new_len, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
        sr = 16000
    return audio, sr


def _read_wav_mono_16k(data: bytes) -> tuple[np.ndarray, int]:
    return _read_audio_mono_16k(data)


def _write_wav_bytes(audio: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    return buf.getvalue()


def load_gigaam():
    global _gigaam
    if _gigaam is not None:
        return _gigaam
    import onnx_asr

    _gigaam = onnx_asr.load_model("gigaam-v3-ctc", quantization="int8")
    _track_rss()
    return _gigaam


def load_whisper():
    global _whisper
    if _whisper is not None:
        return _whisper
    from faster_whisper import WhisperModel

    _whisper = WhisperModel(
        "small",
        device="cpu",
        compute_type="int8",
        download_root=str(CACHE_DIR / "faster-whisper"),
    )
    _track_rss()
    return _whisper


def load_vad():
    global _vad_model
    if _vad_model is not None:
        return _vad_model
    from silero_vad import load_silero_vad

    _vad_model = load_silero_vad()
    _track_rss()
    return _vad_model


def load_tts():
    global _tts_model, _tts_sample_rate, _tts_voices
    if _tts_model is not None:
        return _tts_model, _tts_sample_rate
    import torch

    torch.set_num_threads(max(1, min(4, os.cpu_count() or 2)))
    model, _example = torch.hub.load(
        repo_or_dir="snakers4/silero-models",
        model="silero_tts",
        language="ru",
        speaker=SILERO_MODEL_SPEAKER,
        trust_repo=True,
    )
    _tts_model = model
    _tts_voices = list(getattr(model, "speakers", []) or [])
    sr = getattr(model, "sample_rate", None)
    if sr:
        try:
            _tts_sample_rate = int(sr)
        except Exception:
            _tts_sample_rate = 48000
    else:
        _tts_sample_rate = 48000
    _track_rss()
    return _tts_model, _tts_sample_rate


class HealthOut(BaseModel):
    ok: bool = True
    service: str = APP_NAME
    version: str = APP_VERSION
    role: Literal["adapter-only"] = "adapter-only"
    brain: bool = False
    scheduler: bool = False
    taskAuthority: bool = False
    engines: dict[str, Any] = Field(default_factory=dict)
    cloudFallbackOrder: list[str] = Field(
        default_factory=lambda: ["nvidia-riva-nim", "azure-speech-f0"]
    )
    sensitiveDefaultLocalOnly: bool = True
    peakRssMb: float = 0.0
    cacheDir: str = ""
    python: str = ""


class SttOut(BaseModel):
    text: str
    engine: str
    durationMs: int
    sensitive: bool


class VadOut(BaseModel):
    speech: bool
    speechProbability: float
    engine: str = "silero-vad"


class CloudPolicyIn(BaseModel):
    sensitive: bool = True
    textPreview: str | None = None


class CloudPolicyOut(BaseModel):
    allowCloud: bool
    reason: str
    order: list[str]


@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    import sys

    return HealthOut(
        engines={
            "sttPrimary": "gigaam-v3-ctc-onnx-int8",
            "sttFallback": "faster-whisper-int8",
            "vad": "silero-vad",
            "tts": "silero-tts-v5_4_ru",
            "loaded": {
                "gigaam": _gigaam is not None,
                "whisper": _whisper is not None,
                "vad": _vad_model is not None,
                "tts": _tts_model is not None,
            },
            "loadErrors": dict(_load_errors),
        },
        peakRssMb=_peak_rss_mb,
        cacheDir=str(CACHE_DIR),
        python=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
    )


@app.post("/stt", response_model=SttOut)
async def stt(
    file: UploadFile = File(...),
    engine: Literal["primary", "fallback", "auto"] = Form("auto"),
    force_primary_fail: bool = Form(False),
    sensitive: bool = Form(True),
) -> SttOut:
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty audio")
    t0 = time.perf_counter()
    used = "primary"
    text = ""

    if engine == "fallback" or (engine == "auto" and force_primary_fail):
        used = "fallback"
        text = _stt_whisper(raw)
    elif engine in ("primary", "auto"):
        try:
            if force_primary_fail:
                raise RuntimeError("forced primary failure")
            text = _stt_gigaam(raw)
            used = "primary"
        except Exception as exc:
            _load_errors["gigaam_last"] = str(exc)
            if engine == "primary":
                raise HTTPException(503, f"primary STT failed: {exc}") from exc
            used = "fallback"
            text = _stt_whisper(raw)
    else:
        raise HTTPException(400, "bad engine")

    ms = int((time.perf_counter() - t0) * 1000)
    return SttOut(
        text=(text or "").strip(),
        engine=("gigaam-v3-ctc-onnx-int8" if used == "primary" else "faster-whisper-int8"),
        durationMs=ms,
        sensitive=sensitive,
    )


def _stt_gigaam(raw: bytes) -> str:
    model = load_gigaam()
    audio, sr = _read_audio_mono_16k(raw)
    wav_bytes = _write_wav_bytes(audio, sr)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        path = tmp.name
    try:
        result = model.recognize(path)
        if isinstance(result, (list, tuple)):
            return " ".join(str(x) for x in result)
        return str(result or "")
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _stt_whisper(raw: bytes) -> str:
    model = load_whisper()
    audio, _sr = _read_audio_mono_16k(raw)
    segments, _info = model.transcribe(audio, language="ru")
    parts = [seg.text for seg in segments]
    return " ".join(p.strip() for p in parts if p and p.strip())


@app.post("/vad", response_model=VadOut)
async def vad(file: UploadFile = File(...)) -> VadOut:
    raw = await file.read()
    audio, sr = _read_audio_mono_16k(raw)
    model = load_vad()
    import torch
    from silero_vad import get_speech_timestamps

    tensor = torch.from_numpy(audio)
    ts = get_speech_timestamps(tensor, model, sampling_rate=sr)
    speech = len(ts) > 0
    if len(audio) == 0 or not speech:
        prob = 0.0
    else:
        covered = 0
        for t in ts:
            covered += max(0, int(t["end"]) - int(t["start"]))
        prob = min(1.0, covered / float(len(audio)))
    return VadOut(speech=speech, speechProbability=float(prob))


@app.post("/tts")
async def tts(
    text: str = Form(...),
    speaker: str = Form(SILERO_MODEL_SPEAKER),
    voice: str = Form(SILERO_DEFAULT_VOICE),
) -> Response:
    if not text.strip():
        raise HTTPException(400, "empty text")

    # Accept common client mistake: speaker=<voice-id> instead of model package.
    known_voices = {"aidar", "baya", "kseniya", "xenia"}
    model_package = speaker
    voice_id = voice or SILERO_DEFAULT_VOICE
    if speaker in known_voices:
        voice_id = speaker
        model_package = SILERO_MODEL_SPEAKER
    if model_package != SILERO_MODEL_SPEAKER:
        raise HTTPException(
            400,
            f"only {SILERO_MODEL_SPEAKER} model package allowed (or pass voice id as speaker)",
        )

    # Reject before model load — Silero v5_4_ru raises bare ValueError on Latin-only text,
    # and cold load is expensive / crash-prone under dual-adapter torch pressure.
    if not re.search(r"[А-Яа-яЁё]", text):
        raise HTTPException(
            400,
            "silero v5_4_ru requires Cyrillic Russian text; Latin-only input rejected",
        )

    try:
        model, sample_rate = load_tts()
    except Exception as exc:
        LOG.exception("tts model load failed")
        raise HTTPException(503, f"tts load failed: {type(exc).__name__}: {exc}") from exc

    voices = _tts_voices or list(known_voices)
    if voice_id not in voices:
        raise HTTPException(400, f"voice must be one of {voices}")

    try:
        try:
            audio = model.apply_tts(text=text, speaker=voice_id, sample_rate=sample_rate)
        except TypeError:
            audio = model.apply_tts(text, speaker=voice_id, sample_rate=sample_rate)
    except ValueError as exc:
        LOG.exception("silero apply_tts ValueError text=%r", text[:120])
        raise HTTPException(
            400,
            f"silero rejected text (unsupported symbols or empty after normalize): {exc or 'ValueError'}",
        ) from exc
    except Exception as exc:
        LOG.exception("silero apply_tts failed text=%r", text[:120])
        raise HTTPException(
            500,
            f"tts synthesize failed: {type(exc).__name__}: {exc or repr(exc)}",
        ) from exc

    if hasattr(audio, "detach"):
        arr = audio.detach().cpu().numpy()
    else:
        arr = np.asarray(audio, dtype=np.float32)
    arr = np.asarray(arr, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        raise HTTPException(500, "tts produced empty audio")
    pcm = np.clip(arr, -1.0, 1.0)
    pcm_i16 = (pcm * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm_i16.tobytes())
    data = buf.getvalue()
    headers = {
        "X-Atlas-TTS-Engine": "silero-tts",
        "X-Atlas-TTS-Model": SILERO_MODEL_SPEAKER,
        "X-Atlas-TTS-Speaker": voice_id,
        "X-Atlas-TTS-Sample-Rate": str(sample_rate),
        "X-Atlas-TTS-Bytes": str(len(data)),
    }
    return Response(content=data, media_type="audio/wav", headers=headers)


@app.post("/ptt", response_model=SttOut)
async def push_to_talk(
    file: UploadFile = File(...),
    sensitive: bool = Form(True),
) -> SttOut:
    """Push-to-talk: audio in → text out (wake word later)."""
    return await stt(file=file, engine="auto", force_primary_fail=False, sensitive=sensitive)


@app.post("/cloud-policy", response_model=CloudPolicyOut)
def cloud_policy(body: CloudPolicyIn) -> CloudPolicyOut:
    order = ["nvidia-riva-nim", "azure-speech-f0"]
    if body.sensitive:
        return CloudPolicyOut(
            allowCloud=False,
            reason="sensitive audio stays local-only (ADR-0010)",
            order=order,
        )
    return CloudPolicyOut(
        allowCloud=True,
        reason="non-sensitive may use cloud fallback order",
        order=order,
    )


@app.post("/warmup")
def warmup(engines: str = Form("gigaam,vad,tts,whisper")) -> dict[str, Any]:
    wanted = {e.strip() for e in engines.split(",") if e.strip()}
    out: dict[str, Any] = {"ok": True, "loaded": {}}
    try:
        if "gigaam" in wanted:
            load_gigaam()
            out["loaded"]["gigaam"] = True
        if "whisper" in wanted:
            load_whisper()
            out["loaded"]["whisper"] = True
        if "vad" in wanted:
            load_vad()
            out["loaded"]["vad"] = True
        if "tts" in wanted:
            load_tts()
            out["loaded"]["tts"] = True
    except Exception as exc:
        raise HTTPException(503, f"warmup failed: {exc}") from exc
    out["peakRssMb"] = _peak_rss_mb
    return out
