# Atlas Documents Adapter (ADR-0010 Phase 2)

Local FastAPI sidecar for OCR / tables. **Not a brain.**

## Runtime

- Python **3.12** venv at `adapters/documents/.venv`
- Default bind: `127.0.0.1:8766`
- Env: `ATLAS_DOCS_URL`, `ATLAS_DOCS_CACHE`, `TESSDATA_PREFIX`, `TESSERACT_CMD`
- VRAM gate: refuses OCR warmup while Voice heavy models loaded unless `ATLAS_OCR_ALLOW_WITH_VOICE=1`

## Engines

| Role | Model |
|------|--------|
| Primary OCR | PaddleOCR-VL 1.6 via HF Transformers |
| Tables | PP-StructureV3 (paddlex / paddleocr) |
| Fallback | Tesseract `rus+aze+eng` |

## Start

```powershell
adapters\documents\.venv\Scripts\python.exe adapters\documents\serve.py
```
