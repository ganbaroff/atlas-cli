"""Atlas Documents adapter — FastAPI sidecar (ADR-0010 Phase 2).

PaddleOCR-VL 1.6 (HF Transformers) + PP-StructureV3 tables + Tesseract fallback.
No scheduler. No brain. Called by atlas-cli over HTTP.
"""

from __future__ import annotations

import io
import json
import logging
import os
import traceback
from pathlib import Path
from typing import Any, Literal
from urllib.error import URLError
from urllib.request import urlopen

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from PIL import Image, ImageDraw, ImageFont

APP_NAME = "atlas-documents-adapter"
APP_VERSION = "0.1.0"
ROOT = Path(__file__).resolve().parent
CACHE_DIR = Path(os.environ.get("ATLAS_DOCS_CACHE", ROOT / ".cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
TESSDATA = Path(os.environ.get("TESSDATA_PREFIX", ROOT / "tessdata"))
TESSERACT_CMD = os.environ.get(
    "TESSERACT_CMD",
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
)
VOICE_URL = os.environ.get("ATLAS_VOICE_URL", "http://127.0.0.1:8765").rstrip("/")
# Fail-closed dual-load unless CEO overrides.
ALLOW_WITH_VOICE = os.environ.get("ATLAS_OCR_ALLOW_WITH_VOICE", "0") == "1"
MODEL_ID = os.environ.get("ATLAS_PADDLEOCR_VL_MODEL", "PaddlePaddle/PaddleOCR-VL-1.6")

LOG = logging.getLogger("atlas.documents")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")

app = FastAPI(title=APP_NAME, version=APP_VERSION, description="Documents OCR adapter. Not a brain.")

_vl_model = None
_vl_processor = None
_structure_pipeline = None
_peak_rss_mb = 0.0
_load_errors: dict[str, str] = {}
_device = "cpu"


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


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
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


class HealthOut(BaseModel):
    ok: bool = True
    service: str = APP_NAME
    version: str = APP_VERSION
    role: Literal["adapter-only"] = "adapter-only"
    brain: bool = False
    scheduler: bool = False
    taskAuthority: bool = False
    python: str = ""
    engines: dict[str, Any] = Field(default_factory=dict)
    peakRssMb: float = 0.0
    cacheDir: str = ""
    tessdata: str = ""
    easyocrForbidden: bool = True


def _voice_loaded() -> dict[str, Any] | None:
    try:
        with urlopen(f"{VOICE_URL}/health", timeout=2) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return {"_error": str(exc)}


def _contention_gate(action: str) -> None:
    """O08: refuse simultaneous Voice+OCR model residency unless explicitly allowed."""
    if ALLOW_WITH_VOICE:
        return
    vh = _voice_loaded()
    if not vh or vh.get("_error"):
        return
    loaded = ((vh.get("engines") or {}).get("loaded")) or {}
    heavy = any(bool(loaded.get(k)) for k in ("gigaam", "whisper", "tts"))
    if heavy and action in ("vl", "structure", "warmup"):
        raise HTTPException(
            409,
            {
                "error": "vram_contention_gate",
                "reason": "Voice heavy models loaded; refuse OCR load on 8GB (set ATLAS_OCR_ALLOW_WITH_VOICE=1 to override)",
                "voiceLoaded": loaded,
                "action": action,
            },
        )


def unload_vl() -> None:
    global _vl_model, _vl_processor
    _vl_model = None
    _vl_processor = None
    try:
        import gc
        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def unload_structure() -> None:
    global _structure_pipeline
    _structure_pipeline = None
    try:
        import gc

        gc.collect()
    except Exception:
        pass


def load_vl():
    global _vl_model, _vl_processor, _device
    if _vl_model is not None:
        return _vl_model, _vl_processor
    _contention_gate("vl")
    # CPU RAM: don't keep StructureV3 resident alongside VL.
    if _structure_pipeline is not None:
        LOG.info("unloading PP-StructureV3 before VL load")
        unload_structure()
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if _device == "cuda" else torch.float32
    LOG.info("loading %s on %s dtype=%s", MODEL_ID, _device, dtype)
    _vl_processor = AutoProcessor.from_pretrained(MODEL_ID, cache_dir=str(CACHE_DIR / "hf"))
    _vl_model = AutoModelForImageTextToText.from_pretrained(
        MODEL_ID,
        dtype=dtype,
        cache_dir=str(CACHE_DIR / "hf"),
    ).to(_device).eval()
    _track_rss()
    return _vl_model, _vl_processor


def load_structure():
    global _structure_pipeline
    if _structure_pipeline is not None:
        return _structure_pipeline
    _contention_gate("structure")
    if _vl_model is not None:
        LOG.info("unloading VL before PP-StructureV3 load")
        unload_vl()
    try:
        from paddlex import create_pipeline
    except ImportError:
        from paddleocr import PPStructureV3  # type: ignore

        _structure_pipeline = ("paddleocr", PPStructureV3(device="cpu"))
        _track_rss()
        return _structure_pipeline

    device = "gpu:0" if os.environ.get("ATLAS_DOCS_USE_GPU") == "1" else "cpu"
    _structure_pipeline = (
        "paddlex",
        create_pipeline(pipeline="PP-StructureV3", device=device),
    )
    _track_rss()
    return _structure_pipeline


def _read_image(raw: bytes) -> Image.Image:
    return Image.open(io.BytesIO(raw)).convert("RGB")


def _vl_infer(image: Image.Image, task: str = "ocr") -> str:
    import torch

    prompts = {
        "ocr": "OCR:",
        "table": "Table Recognition:",
        "formula": "Formula Recognition:",
        "chart": "Chart Recognition:",
        "spotting": "Spotting:",
        "seal": "Seal Recognition:",
    }
    model, processor = load_vl()
    prompt = prompts.get(task, prompts["ocr"])
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    # Keep image modest on CPU to avoid multi-minute inferences / RAM spikes.
    max_pixels = 960 * 28 * 28
    min_pixels = getattr(processor.image_processor, "min_pixels", 256 * 28 * 28)
    try:
        inputs = processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
            processor_kwargs={
                "images_kwargs": {
                    "size": {"shortest_edge": min_pixels, "longest_edge": max_pixels}
                }
            },
        )
    except TypeError:
        inputs = processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        )
    if hasattr(inputs, "to"):
        inputs = inputs.to(_device)
    else:
        inputs = {k: (v.to(_device) if hasattr(v, "to") else v) for k, v in inputs.items()}
    with torch.inference_mode():
        outputs = model.generate(**inputs, max_new_tokens=256)
    in_len = inputs["input_ids"].shape[-1]
    text = processor.decode(outputs[0][in_len:], skip_special_tokens=True)
    return (text or "").strip()


def _tesseract_ocr(image: Image.Image, langs: str = "rus+aze+eng") -> str:
    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
    os.environ["TESSDATA_PREFIX"] = str(TESSDATA)
    return (pytesseract.image_to_string(image, lang=langs) or "").strip()


def _structure_table(raw: bytes) -> dict[str, Any]:
    kind, pipe = load_structure()
    tmp = CACHE_DIR / "tmp_table.png"
    Image.open(io.BytesIO(raw)).convert("RGB").save(tmp)
    rows: list[list[str]] = []
    html = ""
    if kind == "paddlex":
        outputs = list(pipe.predict(input=str(tmp)))
        for res in outputs:
            data = res.json if hasattr(res, "json") else res
            if callable(data):
                data = data()
            if not isinstance(data, dict):
                continue
            # LayoutParsingResultV2 shape: {'res': {...}}
            payload = data.get("res", data)
            for block in payload.get("parsing_res_list") or []:
                if isinstance(block, dict) and block.get("block_label") == "table":
                    html = str(block.get("block_content") or html)
            for table_res in payload.get("table_res_list") or []:
                if not isinstance(table_res, dict):
                    continue
                html = str(table_res.get("pred_html") or html)
                ocr_pred = table_res.get("table_ocr_pred") or {}
                texts = ocr_pred.get("rec_texts") or []
                if texts:
                    # pair as 2-column rows when possible
                    cells = [str(t) for t in texts]
                    if len(cells) >= 2:
                        rows = [cells[i : i + 2] for i in range(0, len(cells), 2)]
                    else:
                        rows = [cells]
            if not rows and html:
                # parse simple <tr><td> grid
                import re

                for tr in re.findall(r"<tr>(.*?)</tr>", html, flags=re.I | re.S):
                    cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, flags=re.I | re.S)
                    cells = [c.strip() for c in cells]
                    if any(cells):
                        rows.append(cells)
            if not rows:
                # last resort: overall OCR texts
                ocr_res = payload.get("overall_ocr_res") or {}
                texts = ocr_res.get("rec_texts") or []
                if texts:
                    rows = [[str(t) for t in texts]]
    else:
        result = pipe.predict(str(tmp))
        text = json.dumps(result, ensure_ascii=False, default=str)[:4000]
        rows = [[text[:200]]] if text else []
        html = text
    return {
        "engine": "PP-StructureV3",
        "backend": kind,
        "rows": rows,
        "html": html[:2000],
        "rowCount": len(rows),
    }


@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    import sys

    return HealthOut(
        python=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        engines={
            "ocrPrimary": "paddleocr-vl-1.6-hf-transformers",
            "tables": "PP-StructureV3",
            "ocrFallback": "tesseract-rus+aze+eng",
            "loaded": {
                "vl": _vl_model is not None,
                "structure": _structure_pipeline is not None,
            },
            "loadErrors": dict(_load_errors),
            "device": _device,
            "allowWithVoice": ALLOW_WITH_VOICE,
        },
        peakRssMb=_peak_rss_mb,
        cacheDir=str(CACHE_DIR),
        tessdata=str(TESSDATA),
    )


@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    engine: Literal["primary", "fallback", "auto"] = Form("auto"),
    force_primary_fail: bool = Form(False),
    task: str = Form("ocr"),
) -> dict[str, Any]:
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty image")
    image = _read_image(raw)
    used = "primary"
    text = ""
    if engine == "fallback" or (engine == "auto" and force_primary_fail):
        used = "fallback"
        text = _tesseract_ocr(image)
    else:
        try:
            if force_primary_fail:
                raise RuntimeError("forced primary failure")
            text = _vl_infer(image, task=task)
            used = "primary"
        except HTTPException:
            raise
        except Exception as exc:
            _load_errors["vl_last"] = f"{type(exc).__name__}: {exc}"
            LOG.exception("primary OCR failed")
            if engine == "primary":
                raise HTTPException(503, f"primary OCR failed: {exc}") from exc
            used = "fallback"
            text = _tesseract_ocr(image)
    return {
        "text": text,
        "engine": (
            "paddleocr-vl-1.6-hf-transformers"
            if used == "primary"
            else "tesseract-rus+aze+eng"
        ),
        "easyocr": False,
    }


@app.post("/table")
async def table(file: UploadFile = File(...)) -> dict[str, Any]:
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty image")
    try:
        out = _structure_table(raw)
    except HTTPException:
        raise
    except Exception as exc:
        LOG.exception("PP-StructureV3 failed")
        raise HTTPException(503, f"PP-StructureV3 failed: {exc}") from exc
    if out.get("rowCount", 0) < 1:
        raise HTTPException(500, "PP-StructureV3 returned empty table")
    return out


@app.post("/vram-gate")
def vram_gate(
    action: str = Form("warmup"),
    strict: bool = Form(True),
) -> dict[str, Any]:
    """O08 probe: strict=true evaluates fail-closed even if ALLOW_WITH_VOICE=1."""
    vh = _voice_loaded()
    loaded = ((vh or {}).get("engines") or {}).get("loaded") or {}
    heavy = any(bool(loaded.get(k)) for k in ("gigaam", "whisper", "tts"))
    if strict:
        allow = not heavy
        return {
            "allow": allow,
            "strict": True,
            "voiceHeavy": heavy,
            "voiceLoaded": loaded,
            "allowWithVoiceEnv": ALLOW_WITH_VOICE,
            "policy": "fail-closed-when-voice-heavy",
        }
    try:
        _contention_gate(action)
        return {"allow": True, "strict": False, "allowWithVoice": ALLOW_WITH_VOICE, "action": action}
    except HTTPException as exc:
        return {"allow": False, "detail": exc.detail, "allowWithVoice": ALLOW_WITH_VOICE}


@app.post("/warmup")
def warmup(engines: str = Form("vl,structure")) -> dict[str, Any]:
    wanted = {e.strip() for e in engines.split(",") if e.strip()}
    out: dict[str, Any] = {"ok": True, "loaded": {}}
    try:
        _contention_gate("warmup")
        if "vl" in wanted:
            load_vl()
            out["loaded"]["vl"] = True
        if "structure" in wanted:
            load_structure()
            out["loaded"]["structure"] = True
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, f"warmup failed: {exc}") from exc
    out["peakRssMb"] = _peak_rss_mb
    return out


@app.get("/fixtures/make")
@app.post("/fixtures/make")
def make_fixtures() -> dict[str, Any]:
    """Generate RU / AZ / table PNG fixtures for acceptance (dev helper)."""
    fx = ROOT / "fixtures"
    fx.mkdir(parents=True, exist_ok=True)
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 36)
    except Exception:
        font = ImageFont.load_default()

    def write_text(path: Path, lines: list[str], size=(900, 400)) -> None:
        img = Image.new("RGB", size, "white")
        draw = ImageDraw.Draw(img)
        y = 40
        for line in lines:
            draw.text((40, y), line, fill="black", font=font)
            y += 60
        img.save(path)

    ru = fx / "ru_page.png"
    az = fx / "az_diacritics.png"
    table = fx / "table_simple.png"
    write_text(ru, ["Документ Atlas", "Сегодня три задачи", "Проверить отчёт клиента"])
    write_text(
        az,
        ["Azərbaycan mətni", "ə ö ğ ş ç ü", "şirkət üçün hesabat"],
        size=(900, 300),
    )
    img = Image.new("RGB", (700, 300), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle([20, 20, 680, 280], outline="black", width=2)
    draw.line([20, 80, 680, 80], fill="black", width=2)
    draw.line([350, 20, 350, 280], fill="black", width=2)
    draw.text((40, 40), "Item", fill="black", font=font)
    draw.text((370, 40), "Amount", fill="black", font=font)
    draw.text((40, 120), "Atlas", fill="black", font=font)
    draw.text((370, 120), "100", fill="black", font=font)
    draw.text((40, 180), "Integronix", fill="black", font=font)
    draw.text((370, 180), "250", fill="black", font=font)
    img.save(table)
    return {"ok": True, "files": [str(ru), str(az), str(table)]}
