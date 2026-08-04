# Cursor Handoff

> Standing end-of-session ritual. Replaced each session. Cursor seat.

## 1. Date, branch, HEAD

- Date: 2026-08-05
- Branch: `codex/atlas-cost-router-design`
- HEAD before this handoff commit:

```
$ git log -1 --oneline
9d93ff8 docs(adr): Record ADR-0010 voice/documents capability stack
```

## 2. What changed this session — files + one line each

- `docs/atlas-cto/ADR-0010-2026-08-05-capability-stack-voice-documents.md` — ACCEPTED ADR: Phase1 Voice + Phase2 Documents; rejected stack; budget/VRAM gates
- `docs/adr/0010-capability-stack-voice-and-documents.md` — numbering stub → atlas-cto ADR body
- `scripts/acceptance/capability-stack/cases.json` — 10 voice + 8 OCR cases (all UNTESTED)
- `scripts/acceptance/capability-stack/run.py` — harness; exit 2 while UNTESTED; `--require-pass` forbids fake done
- `scripts/acceptance/capability-stack/README.md` — how to run

No FastAPI adapters, no model downloads, no daemon.

## 3. Receipts — real output

```
$ python scripts/acceptance/capability-stack/run.py
ADR-0010 capability acceptance - {'PASS': 0, 'FAIL': 0, 'UNTESTED': 18, 'SKIP': 0}
  [UNTESTED] V01 ... V10
  [UNTESTED] O01 ... O08
  [UNTESTED] O01 ... runner_python=3.14.3 (documents 3.12 venv not verified)
exitCode=2 (0=all PASS, 1=FAIL, 2=UNTESTED remaining)
NOT DONE: implement adapters/fixtures until all cases PASS.

$ git log -1 --oneline
9d93ff8 docs(adr): Record ADR-0010 voice/documents capability stack
```

## 4. Risks / broken things you know about

- Host default Python is **3.14.3** — ADR requires Documents on **3.12** venv; do not install Paddle wheels on 3.14 as primary
- All 18 acceptance cases UNTESTED — Voice/Documents **not done**
- RTX 5060 8GB contention Voice+OCR still only policy, not enforced in code
- Disk ~5GB budget not measured yet
- No atlas-cli HTTP client for adapter yet

## 5. Next 3 steps

1. CEO receipt on ADR-0010 (or veto lines)
2. Create Python 3.12 venvs + FastAPI adapter stubs (voice first); wire probes in `run.py`
3. Install GigaAM/Silero within disk budget; only then chase V01–V08 PASS (morning report)

## 6. Blockers that need CEO or the orchestrator chat

- Approve ADR-0010 as written
- Authorize model downloads / disk use (~5GB)
- Authorize Phase 1 adapter implementation wave (still no production/cloud speech for sensitive audio)
