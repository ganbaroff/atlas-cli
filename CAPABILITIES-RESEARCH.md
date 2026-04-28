# Atlas CLI — Capabilities Research (hands, eyes, voice)

**Goal:** Atlas controls PC, phone, browser, reads documents, types confirmations.
**CEO directive:** "вы должны стать лучшими в мире. you have all authority"

## Decision Matrix

### 1. Browser Control — Stagehand (TypeScript, hybrid)

**Winner:** [Stagehand](https://github.com/browserbase/stagehand) by Browserbase
- TypeScript native — matches our stack
- Hybrid: AI primitives (`act`, `extract`, `observe`) on top of Playwright
- 44% faster than v2 (CDP direct, no middleware)
- Auto-caching: AI→deterministic replay, costs drop over time
- Production-grade, not research toy

**Runner-up:** Browser Use (Python, 78K stars, 89% WebVoyager) — but Python, not our stack.

**Why not OpenManus:** Python, general-purpose, overkill for browser tasks. Already on machine but not integrated.

### 2. Desktop Control — Open Computer Use (coasty-ai)

**Winner:** [open-computer-use](https://github.com/coasty-ai/open-computer-use)
- 82% OSWorld verified — state of the art
- Platform-native: PowerShell/Win32 on Windows
- Open source, production-ready
- Browser + terminal + desktop in one

**Runner-up:** UFO (Microsoft, Windows UI Automation, 10K stars) — Windows-only but deep.

### 3. OCR — tesseract.js + Google Vision fallback

**Primary:** [tesseract.js](https://tesseract.projectnaptha.com/) — free, local, TypeScript native, 100+ languages
**Fallback:** Google Cloud Vision API — 1000 free pages/month, 98% accuracy, handwriting support

Both have Node.js SDKs. Use tesseract.js for privacy + cost, Vision API for complex docs.

### 4. Voice — OpenAI Whisper (already wired)

Already working in telegram.ts. $0.006/min. Handles Russian + English.

### 5. Terminal Control — already have shell tool

`src/tools/shell.ts` — 30s timeout, stdout/stderr capture. Atlas already runs commands.

## Integration Priority

| # | Capability | Tool | Effort | Value |
|---|-----------|------|--------|-------|
| 1 | Browser | Stagehand (Mastra tool) | M | Read web, fill forms, scrape |
| 2 | Screen read | tesseract.js (Mastra tool) | S | OCR documents, screenshots |
| 3 | Desktop | open-computer-use | L | Full PC control |
| 4 | Voice | Whisper (done) | ✅ | Telegram voice |
| 5 | Terminal | shell tool (done) | ✅ | Run commands |

## Implementation Plan

**Phase A (next sprint):** Stagehand as Mastra tool. `atlas browse "go to volaura.app, check if login works"`. Atlas opens browser, navigates, reports.

**Phase B:** tesseract.js as Mastra tool. `atlas ocr ./document.pdf`. Atlas reads document, extracts text.

**Phase C:** open-computer-use integration. Atlas controls Windows desktop — opens apps, clicks, types. This is the "full operator" phase.

## Sources
- [Browser Use](https://browser-use.com/) — 78K stars, Python
- [Stagehand](https://github.com/browserbase/stagehand) — TypeScript, Playwright + AI
- [Open Computer Use](https://github.com/coasty-ai/open-computer-use) — 82% OSWorld
- [Agent Browser (Vercel)](https://github.com/nicepkg/agent-browser) — Rust CLI, 14K stars
- [tesseract.js](https://tesseract.projectnaptha.com/) — JS OCR
- [AgentQL](https://www.agentql.com/) — semantic web queries
- [Fazm](https://fazm.ai/) — macOS desktop, accessibility tree
