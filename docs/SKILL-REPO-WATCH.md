# Skill: repo_watch (Phase 3, NOTIFY-ONLY)

Reads the git status of the configured repo roots and, **only on change + within
the rate limit**, sends the CEO a compact Telegram digest. It never mutates a repo.

Code: `src/atlas/repo-watch.ts` · CLI `atlas repo-watch`.

## Use
```
node dist/cli.js repo-watch            # print status, do NOT notify (dry)
node dist/cli.js repo-watch --notify   # send a Telegram digest if changed + rate-limit allows
```
Run it on a schedule (Windows Task Scheduler, or the existing cron) with `--notify`.

## What it reports (READ-ONLY git)
Per repo: current branch, dirty-file count, commits ahead of upstream (local, no
fetch), and the last commit. Example:
```
Repo watch:
- ANUS: branch feat/arsenal-wiring, 12 dirty — 8a12ec7 feat(desktop): ...
- VOLAURA: branch feature/atlas-integration, 17 dirty — 450cce84 WIP: ...
```

## Config (policy.yaml → env override)
```yaml
skills:
  repo_watch:
    interval_min: 15         # min minutes between notifications (anti-spam)
    roots:
      - 'C:\Users\user\OneDrive\Documents\GitHub\ANUS'
      - 'C:\Projects\VOLAURA'
```
- `ATLAS_REPO_WATCH_INTERVAL_MIN` overrides the interval.
- `ATLAS_REPO_WATCH_ROOTS` (';'-separated) overrides the roots.

## Notify discipline (no spam)
A digest is sent only when **both** hold:
1. **Changed** — the status signature (branch/dirty/ahead/last-commit per repo)
   differs from the last sent digest.
2. **Interval elapsed** — at least `interval_min` since the last send.

Delivery goes through the shared `notifyCeo` gate (`src/atlas/notify.ts`) as an
`important` message to `TELEGRAM_CEO_CHAT_ID`. Bot token is read from env and never
logged. Verified 2026-07-16 (simulated send): digest delivered; `chatter`-kind is
gated/silent; change + rate-limit gating unit-tested.

## Hard boundaries
- **No** auto-commit, auto-push, auto-merge, or fetch (fetch is not performed;
  ahead-count is local-only).
- Read-only git commands only (`rev-parse`, `status`, `log`, `rev-list`).
- Fail-closed: a non-repo root reports `git error` and never throws.

## Tests
`src/__tests__/repo-watch.test.ts` — real-repo status, non-repo fail-closed, digest
format, and the change + rate-limit decision gate.
