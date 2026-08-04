#!/usr/bin/env python3
"""Start Atlas voice adapter (ADR-0010). No brain/scheduler."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

import uvicorn

if __name__ == "__main__":
    host = os.environ.get("ATLAS_VOICE_HOST", "127.0.0.1")
    port = int(os.environ.get("ATLAS_VOICE_PORT", "8765"))
    uvicorn.run("app:app", host=host, port=port, reload=False, log_level="info")
