# ADR-0005: `notify.ts` remains the only CEO-notification authority

- **Status:** ACCEPTED
- **Date:** 2026-07-17
- **Deciders:** External CTO (authority correction), CEO (Yusif Ganbarov)

## Context

`src/atlas/notify.ts` was built in Phase 3.6 specifically to stop
uncontrolled proactive Telegram sends (its own header: *"The problem: the
brain-loop and proactive engines could ping the CEO whenever mood said
'probe'. That is exactly the noise voice.md warns against. This is the ONE
gate every proactive send passes through."*). It gates on `NotifyKind`
(`briefing`/`error`/`important`/`remote-result` allowed; everything else,
default `chatter`, silenced) and, since V0.1 (`docs/AUTONOMY-V0.md`), offers
`notifyCeoResult()` — a typed `NOT_CONFIGURED | SUPPRESSED | SENT | FAILED`
outcome that resolves the CEO chat ID **internally only**
(`TELEGRAM_CEO_CHAT_ID`), with no parameter on the function or its callers
through which a different chat ID could be targeted (proven by test, per
`docs/AUTONOMY-V0.md`'s V0.1 section).

EB-0 adds two new read surfaces that talk to the CEO — Telegram `/status`
(`telegram.ts`'s `bot.command('status', ...)`) and the morning brief
(`telegram.ts`'s `sendMorningBriefing()`) — both now append an exec-graph
section (via `src/exec-graph/brief.ts`). This ADR settles, explicitly, that
adding exec-graph visibility to these surfaces does not create a second
notification authority.

## Decision

- **`notify.ts` is the only alerting authority in this repository.** No new
  module introduced by EB-0 (`exec-graph/brief.ts`, `autonomy-loop.ts`,
  anything else) sends a Telegram message directly or resolves its own CEO
  chat ID. Anything that needs to *proactively* alert the CEO goes through
  `notifyCeo()` or `notifyCeoResult()`.
- **`/status` and the morning brief are not proactive alerts — they reuse
  existing, already-gated send paths**, not `notify.ts`'s proactive gate:
  - `/status` is a CEO-initiated pull (a Telegraf command handler) — it
    replies via `ctx.reply()`, the same as every other command handler. It
    is not a proactive send and does not go through `shouldNotify()`;
    `notify.ts`'s gate exists specifically for *unprompted* sends, and a
    reply to a CEO command is, by definition, prompted.
  - The morning brief (`sendMorningBriefing()`) is a scheduled proactive
    send, but it is scheduled and gated at the existing `briefing` kind
    (already in `notify.ts`'s `ALLOWED` set) — `scheduleMorningBriefing()`
    calls `sendMorningBriefing()`, which sends via `bot.telegram.sendMessage`
    directly to `CEO_CHAT_ID` (resolved once, module-level, from
    `TELEGRAM_CEO_CHAT_ID`, the same env var `notify.ts` uses internally).
    It does not introduce a new proactive-send authority; it is the
    pre-existing, already-shipped `briefing` surface, unchanged in kind by
    EB-0's addition of an exec-graph section to its body.
  - `exec-graph/brief.ts` (`formatStatusMessage`, `formatMorningBriefSection`)
    is pure text formatting — no I/O, no network calls, no chat-ID
    resolution (`src/exec-graph/README.md`'s "Consumers" section is
    explicit: the Telegram/brief formatting is pure functions, unit-testable
    without a ledger on disk). It cannot become a notification authority
    because it cannot send anything.
- **Both new exec-graph read sections degrade to a one-line note on
  failure**, never to a crash and never to a silent drop of the rest of the
  message — each call site wraps its own dynamic import + read in its own
  try/catch (see `telegram.ts` around the `/status` handler and
  `sendMorningBriefing()`), so a broken or read-only exec-graph state
  directory (e.g. Railway's read-only image, per `src/exec-graph/README.md`)
  cannot take down `/status` or the brief.

## Alternatives considered

1. **Give `exec-graph/brief.ts` its own send function for exec-graph-
   specific alerts (e.g. "a task just got escalated — notify now").**
   Rejected for EB-0: that would be a second proactive-alert authority,
   exactly what `notify.ts` was built to prevent. If exec-graph needs
   proactive alerts in the future (e.g. "new escalation"), that alert must
   route through `notifyCeoResult()` with an appropriate `NotifyKind`, not
   through a parallel path.
2. **Route `/status` and the morning brief through `notifyCeoResult()`
   instead of their existing `ctx.reply()` / `bot.telegram.sendMessage()`
   calls.** Rejected: `/status` is a direct reply to a CEO-initiated
   command, not a proactive alert — routing it through the proactive gate
   would be a category error (and `shouldNotify()` doesn't apply to replies
   at all). The morning brief already has its own dedicated, tested
   schedule (`scheduleMorningBriefing()`) predating EB-0; rewriting it to
   route through `notify.ts` was assessed as unnecessary churn to a
   working, already-`briefing`-classified surface for no behavior change.
3. **Merge `notify.ts` and `exec-graph/brief.ts` into one module.**
   Rejected: different responsibilities (gating/sending vs. pure text
   formatting) with different testability needs — `brief.ts`'s tests
   (`src/__tests__/exec-graph-brief.test.ts`) run with no ledger and no
   Telegram mock precisely because it does no I/O. Merging would
   re-couple them.

## Consequences

- **Positive:** one place (`notify.ts`) to audit for "when does Atlas ever
  interrupt the CEO unprompted," unchanged by EB-0.
- **Positive:** exec-graph visibility ships without adding a new failure
  mode for alert-fatigue or duplicate-authority bugs (the exact class of bug
  `docs/AUTONOMY-V0.md`'s V1 section describes fixing for the autonomy
  loop).
- **Negative / cost:** exec-graph currently has no proactive alerting at all
  (e.g. no "task escalated" push) — visibility is pull-only (`/status`,
  daily brief). Acceptable for EB-0; a future proactive exec-graph alert
  must be designed as a new `notifyCeoResult()` call site, not a bypass.

## Rollback or supersession

Rollback: revert the `/status` and `sendMorningBriefing()` exec-graph
sections in `telegram.ts` (each is a self-contained try/catch block); no
change to `notify.ts` itself is needed to roll this back, since this ADR
did not modify `notify.ts`.

Supersession: if exec-graph needs proactive alerts, a future ADR should
define the new `NotifyKind` (or reuse `important`/`error`) and the specific
transition conditions that qualify — following the same "signal changed for
a real reason, not just something happened" discipline
`docs/AUTONOMY-V0.md`'s V1 alert semantics established for the autonomy
loop, so exec-graph doesn't reintroduce the duplicate-alert bug that work
fixed.

## Links

- `src/atlas/notify.ts` — the gate (module header is the canonical spec).
- `src/exec-graph/brief.ts` — pure formatting functions used by both
  surfaces.
- `src/exec-graph/README.md` — "Consumers" section.
- `docs/AUTONOMY-V0.md` — V1 alert-semantics precedent this ADR points any
  future proactive exec-graph alert back to.
- `src/__tests__/exec-graph-brief.test.ts`, `src/__tests__/notify.test.ts`
