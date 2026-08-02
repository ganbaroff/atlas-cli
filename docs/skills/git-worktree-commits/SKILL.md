# Skill: Git Worktree & Atomic Commits (DESIGN)

## Purpose
Isolate tip-altering work; one lead writer; atomic commits of only authorized paths.

## Scope
- Create/use ANUS git worktrees under `.worktrees/` (excluded from tip noise).
- Stage **named paths only** — never `git add .` for safety waves.
- Commit messages: conventional, why-focused; merge `--no-ff` when rollback-via-revert desired.

## Inputs
- Base tip SHA/branch (e.g. `codex/atlas-cost-router-design`).
- Authorized file list for the wave.

## Outputs
- Worktree path + branch name.
- Commit SHA(s), merge SHA, parent SHA.
- `git diff --name-status` proof of scope.

## Tools (examples / inspection only — never a capability grant)
- Inspection/examples: `git worktree`, `git status`, `git diff`, `git add -- <paths>`.
- `git commit` / `git merge` require explicit CEO/wave scope authority; listing them here is not permission to run them.

## Forbidden
- Commit/push without CEO auth when wave says STOP before commit.
- Force-push; amend pushed commits; `--no-verify` unless explicitly authorized.
- Mixing unrelated dirty files into the commit.
- Durable checkout edits outside the authorized worktree flow.

## How agents use it
**Cursor/Claude:** Before any tip edit, open/create worktree; after VERIFY, stage exact paths; return SHAs. Subagents stay read-only unless CEO authorizes write.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Base tip SHA; authorized path list; worktree plan |
| BUILD | Edits only inside isolated worktree/branch |
| VERIFY | `git status` / `git diff --name-status` matches authorized paths only |
| BIND | Record worktree path, branch, staged path list |
| OBSERVE | Return commit/merge SHAs when CEO authorized commit |
| ROLLBACK | Leave uncommitted; or (if CEO authorized merge) document `git revert -m 1 <merge>` — **do not execute** unless authorized |

**STOP when:** dirty set includes unauthorized paths; wave says no commit; or push would be required without CEO auth.

**Rollback boundary (design-only):** Prefer abandon worktree changes / delete unmerged branch. This skill doc itself does not authorize revert execution.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
