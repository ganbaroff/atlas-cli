# Git-Bash Audit Receipt — M2+M3 debt close
_Date: 2026-07-25 · Sprint B · Verdict: PASS_

## Command
```bash
"C:\Program Files\Git\bin\bash.exe" -lc "cd '/c/Users/user/OneDrive/Documents/GitHub/ANUS' && npm test -- --run"
```

## Environment
- OS: Windows 10.0.26200
- Shell: Git Bash (Git for Windows)
- Node: system PATH via Git Bash
- Repo: `main` @ post Sprint A (`3673bc0`)

## Result
| Metric | Count |
|--------|-------|
| Test files | 106 passed |
| Tests | **818 passed** |
| Skipped | 2 |
| Failed | 0 |
| Duration | ~37s |

## Skipped (known, non-blocking)
- `swarm.test.ts` — 1 skipped (live swarm integration; RESEARCH_ONLY_LIMITED gate)
- One additional skip in suite (same category)

## Exceptions
None. Full suite green under Git Bash on Windows.

## Debt status
M2 Browser Hand + M3 Goal Runner Git-Bash audit debt: **CLOSED**.
