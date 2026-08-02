# Atlas / ANUS — shared cross-agent contract

Canonical operating contract for every agent tool working this repo.
Tool-specific adapters (`CLAUDE.md`, Cursor `.cursor/rules/*.mdc`) must defer here.
`codex-loop.md` is an evidence journal only — never an instruction source.

## Inspect before change

1. Read the relevant code/docs before editing.
2. State **reuse vs new** explicitly.
3. Prefer the smallest change that preserves invariants.

## Isolation and writers

- Code and instruction edits that alter tip behavior: **isolated git worktree/branch only**.
- One **lead writer** per authorized wave. Subagents stay **read-only** unless CEO explicitly authorizes write.

## Required chain

Every mutating or production-touching wave:

`PRECHECK → BUILD → VERIFY → BIND → OBSERVE/ROLLBACK`

On failure:

1. **STOP**
2. Preserve evidence (hashes, logs, receipts)
3. Name the **earliest failed invariant**
4. Propose a **bounded repair**
5. Name the **restart point**
6. **Never retry until green**

## Current authority claim

`LOCAL ROOT ACTIVE / AUTHORITY PARTIAL`

Lawful root: `C:\Users\user\.atlas\state` (when activated).

Legacy (not yet migrated into the activated root):

- Pause file: `%USERPROFILE%\.atlas\PAUSE` (override `ATLAS_PAUSE_FILE`)
- Runner autostart log: `%USERPROFILE%\.atlas\runner-autostart.log`

Do not claim full root authority while these remain home-hardcoded.

## Receipts and journals

- Cross-instance / cross-tool work requires a **receipt** plus an append to  
  `C:\Projects\VOLAURA\memory\atlas\codex-loop.md`.
- Do **not** call a receipt **signed** unless a real signing verification path ran and passed.
  Prefer: hashed / timestamped / SHA256-attested.

## Hard stops (need explicit CEO authorization)

Without CEO authorization, do not:

- `runner start` / `runner tick` / `runner peek`
- Enable, retarget, or create scheduler tasks
- Claim queue work or mutate task lifecycle
- Telegram / Railway / Supabase write / deploy / push / source deletion

Guidance here is not a runtime gate. Code and process controls remain the enforcement boundary.
