# Atlas skill contracts (design)

**Status:** DESIGN ONLY — not implemented as Cursor/Claude loadable `SKILL.md` packages.
**Tip base:** `073f1e5`
**Authority:** `LOCAL ROOT ACTIVE / AUTHORITY PARTIAL`

## Skill surface audit (read-only, 2026-08-02)

Loader status marks: **CONFIRMED** = local path/command evidence in-repo; **INFERRED** = tool convention without session proof; **UNKNOWN** = no local evidence.

| Path | Loader (claim) | Status | Evidence / notes |
|---|---|---|---|
| `AGENTS.md` | Cursor / any reader (convention) | **INFERRED** | File tracked at repo root; Cursor AGENTS.md convention — auto-load not proven this session |
| `CLAUDE.md` | Claude Code; Cursor inject possible | **INFERRED** | File tracked; Claude CLAUDE.md convention; Cursor inject unverified |
| `.cursor/rules/atlas-safety.mdc` | Cursor if ANUS is project root | **INFERRED** | File tracked (`git ls-files`); `alwaysApply: true` in frontmatter; session load unverified |
| `codex-loop.md` (VOLAURA memory) | Human/agents append | **CONFIRMED** (path role) | Absolute path cited in AGENTS.md; journal-not-instructions stated there |
| `docs/qa/ATLAS_QA_HARNESS.md` | Human / agents by path | **CONFIRMED** | Tracked under `docs/qa/` on tip |
| `qa/**` stubs | `npm run test:qa` / `eval:critical` | **CONFIRMED** | `package.json` scripts + `vitest.qa.config.ts`; default `vitest.config.ts` still `src/**/*.test.ts` |
| `docs/SKILL-SCREEN.md` | Manual / docs | **CONFIRMED** | Tracked `docs/SKILL-SCREEN.md` |
| `docs/SKILL-EMAIL.md` | Manual / docs | **CONFIRMED** | Tracked `docs/SKILL-EMAIL.md` |
| `docs/SKILL-REPO-WATCH.md` | Manual / docs | **CONFIRMED** | Tracked `docs/SKILL-REPO-WATCH.md` |
| `skills/` (ANUS root) | — | **CONFIRMED** unused | Empty directory (child count 0) |
| `.agents/skills/` | Unknown remnant | **UNKNOWN** loader / **CONFIRMED** no skill packages | Dir may exist; no Agent-Skill `SKILL.md` packages found |
| `GEMINI.md` | — | **CONFIRMED** missing | `Test-Path GEMINI.md` → false |
| Cursor User Rules | Cursor session | **UNKNOWN** | Non-file; not observable via git in this repo |
| `C:\Projects\ATLAS\skills\caveman` | If ATLAS root opens skills | **INFERRED** external | Outside ANUS tip; not versioned here |
| `~/.claude/skills/*`, `~/.cursor/skills-cursor/*` | Claude / Cursor global | **UNKNOWN** / external | Host-level; not versioned in ANUS |

**Gemini:** no in-repo skill loader found (**CONFIRMED** missing `GEMINI.md`).
**No** additional `.cursor/rules/*.mdc` beyond `atlas-safety.mdc` (**CONFIRMED** in `.cursor/rules/`).
**These** `docs/skills/**/SKILL.md` are design contracts only — **not** installed loadable packages (**CONFIRMED** by this README status line).

## Design contracts in this folder

| # | Directory | Skill |
|---|---|---|
| 1 | `harness-instructions/` | Harness / Instructions |
| 2 | `git-worktree-commits/` | Git Worktree & Atomic Commits |
| 3 | `qa-runtime/` | QA Runtime |
| 4 | `eval-design/` | Eval Design |
| 5 | `security-least-privilege/` | Security / Least-Privilege |
| 6 | `prompt-contract/` | Prompt-Contract |
| 7 | `code-review/` | Code Review |
| 8 | `logging-receipts/` | Logging & Receipts |
| 9 | `recovery-backup/` | Recovery & Backup |
| 10 | `red-team-deny/` | Red-Team / Deny-Rules |

Each `SKILL.md` here is a **contract design**. Implementation = separate auth (copy into Cursor skills, or `.agents/skills`, with frontmatter).
