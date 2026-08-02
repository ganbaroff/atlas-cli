# Skill: Logging & Receipts (DESIGN)

## Purpose
Produce auditable evidence: hashes, timestamps, earliest failed step — never fake “signed”.

## Scope
- Append-only `C:\Projects\VOLAURA\memory\atlas\codex-loop.md` for cross-instance work.
- Per-wave receipts: PRECHECK/VERIFY fields, SHAs, before/after artifact hashes.
- Align with future `docs/qa/RECEIPT-SCHEMA.md` (proposed).

## Inputs
- Wave ID, commands run, exit codes, artifact paths.

## Outputs
- Journal entry + optional JSON receipt.
- Language: “SHA256-attested” / “timestamped”; **not** “signed” unless verify ran.

## Tools
- File append to codex-loop; `Get-FileHash` / `sha256sum`; git rev-parse.

## Forbidden
- Calling unsigned hashes “signed”.
- Rewriting history in codex-loop (append only).
- Logging secrets, tokens, raw `.env`.

## How agents use it
**End of every authorized wave:** append receipt.
**On STOP:** preserve evidence; name restart point before any retry.

## Contract chain (required)
`PRECHECK → BUILD → VERIFY → BIND → OBSERVE` or `ROLLBACK`

| Step | This skill |
|---|---|
| PRECHECK | Wave ID; what will be hashed; no secrets in log plan |
| BUILD | Collect command outputs / hashes during wave |
| VERIFY | Receipt fields complete; language not falsely “signed” |
| BIND | Tip SHA + artifact SHA256s in receipt |
| OBSERVE | Append `codex-loop.md` when cross-instance (journal only) |
| ROLLBACK | On failure: keep evidence; do not rewrite journal history |

**STOP when:** receipt would require logging secrets, or would claim “signed” without verification.

**Rollback boundary (design-only):** Do not delete prior journal entries. Correct via new append. No tip revert from this skill.

**Enforcement / authority:** This document is **guidance only**. It has **no runtime enforcement** and **no authority** to perform forbidden actions. The complete hard-stop list lives only in `AGENTS.md` (section "Hard stops") — without CEO authorization do not: `runner start` / `runner tick` / `runner peek`; enable, retarget, or create scheduler tasks; claim queue work or mutate task lifecycle; Telegram / Railway / Supabase write / deploy / push / source deletion. Do not treat any shorter paraphrase as complete. Code and process controls remain the enforcement boundary.
