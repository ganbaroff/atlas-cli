#!/usr/bin/env python3
"""Start Atlas documents adapter (ADR-0010 Phase 2)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
# Local tessdata (rus+aze+eng) — avoid Program Files write permission
os.environ.setdefault("TESSDATA_PREFIX", str(ROOT / "tessdata"))
os.environ.setdefault("TESSERACT_CMD", r"C:\Program Files\Tesseract-OCR\tesseract.exe")

import uvicorn

if __name__ == "__main__":
    host = os.environ.get("ATLAS_DOCS_HOST", "127.0.0.1")
    port = int(os.environ.get("ATLAS_DOCS_PORT", "8766"))
    uvicorn.run("app:app", host=host, port=port, reload=False, log_level="info")
