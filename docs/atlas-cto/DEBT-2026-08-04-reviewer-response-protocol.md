# DEBT-2026-08-04 — Reviewer response protocol (MALFORMED_REVIEW)

**Severity:** MEDIUM (process) — does **not** block Goal Intake v0 merge  
**Owner:** Atlas DevOS (atlas-builder)  
**Source:** CEO ACCEPT+MERGE Goal Intake v0 (2026-08-04)  
**Related:** Courier Loop v0 ChatGPT reviewer (`adapter.chatgpt-browser-reviewer`)

## Problem

During Goal Intake v0 courier review, a ChatGPT response of bare `VERDICT: REJECT` (no rationale / no required schema fields) was treated as low-signal and discarded in favor of a reasoned re-ask. That is operationally unsafe: a malformed reviewer response must not be silently discarded or reinterpreted as ACCEPT/REJECT.

## Required debt

**Name:** `Reviewer response protocol`

A reviewer response without required rationale or valid schema must become:

```text
MALFORMED_REVIEW
```

It must **not** be silently discarded.  
It must **not** be interpreted as `ACCEPT` or `REJECT`.

## Acceptance criteria (future wave)

1. Adapter/parser emits explicit `MALFORMED_REVIEW` when verdict line missing required companion fields (e.g. REPAIR without in-scope instruction; REJECT/ACCEPT without required rationale when contract demands it; empty body; unparseable schema).
2. Courier loop treats `MALFORMED_REVIEW` as fail-closed: stop or bounded re-prompt once under explicit protocol — never invent ACCEPT.
3. EvidencePack records raw response + `MALFORMED_REVIEW` code.
4. Regression tests cover bare verdict, empty response, out-of-schema text.

## Non-goals

No change in this merge. No Hermes/Codex/OpenManus. No production/deploy.

## Trigger

Next courier-loop hardening wave or before any unattended multi-cycle review automation.
