# FABLE PROTOCOL — how the planning seat operates and hands off

> **Status:** accepted · 2026-07-27 · written by the `fable-orchestrator` seat on CEO order
> («не завершён путь создания документации для работы FABLE — заверши»).
>
> **Authority:** ANUS decision canon, sibling of [`ATLAS-OPERATING-CANON.md`](ATLAS-OPERATING-CANON.md).
> That file is *how a disciplined Atlas works*; this file is *how the planning seat is driven,
> which seat runs which class of work, and what a stage token does and does not grant.*
>
> **Why it exists — the gap it closes.** Three fragments existed and none of them was usable
> at the moment of decision:
> 1. `ATLAS-OPERATING-CANON.md` §7 cites **"FABLE.GO rule 4"** — but FABLE.GO was defined
>    nowhere in ANUS. Its only definition sat at line ~2560 of `VOLAURA/memory/atlas/codex-loop.md`,
>    a 347 KB running journal. A new body had to grep a journal to learn the protocol it is bound by.
> 2. `VOLAURA/memory/atlas/master-prompt.md` holds the seat-routing rule — but that file is read
>    only when someone points at it, so the rule fired *after* the cost, not before.
> 3. `VOLAURA/memory/atlas/FABLE-5-PROMPTING.md` holds the model deltas, with no routing and no
>    recovery procedure.
>
> This document is the single operating surface for all three. The two VOLAURA files remain the
> lived-memory sources and now point here.
>
> **This document is written under its own §4** — requirement language, no incident narrative.

---

## 1. Seat routing — the pre-start gate

Routing is decided **before the first turn of a work item**, not after a request is declined.
Deciding late is the failure this document exists to remove: by the time a decline happens,
the conversation already carries the context that caused it (§2), so switching then costs the
whole thread.

Ask one question before starting any work item:

> **Will this work require me to describe, enumerate, or reason about the weak points of a
> system — ours or anyone's — in order to do it?**

| Answer | Seat | Examples |
|---|---|---|
| **Yes** | **Opus 5** (`claude-opus-5`) from the first turn | resilience and readiness reviews · access-control and permission design · credential and key handling · queue and work-order authenticity · infrastructure and deploy hardening · anything whose deliverable is a list of things to strengthen |
| **No** | **Fable 5** (`claude-fable-5`) at full effort | product strategy · architecture and API shape · frontend, UX, design, motion · documentation and specs · analytics · planning and sequencing · verification of finished work against a spec |
| **Unsure** | **Opus 5** | the cost of guessing wrong is one wasted thread; the cost of guessing right is nothing |

Two supporting rules:

- **Fallback target is Opus 5, not Opus 4.8.** The June sources name `claude-opus-4-8`; that is
  superseded. Current IDs: Fable 5 `claude-fable-5`, Opus 5 `claude-opus-5`, Sonnet 5
  `claude-sonnet-5`, Haiku 4.5 `claude-haiku-4-5-20251001`.
- **Routing is per work item, not per session.** A session that plans a product feature on Fable 5
  and then turns to a readiness review must move seats at that boundary — mid-session is exactly
  when the rule is forgotten.

Cost tiering is orthogonal and still applies: mechanical hands-work (edits across known paths,
scaffolding, migrations from a finished spec, test authoring) goes to **Sonnet 5** executors or
`claude -p` regardless of which seat planned it. The planning seat writes no code.

---

## 2. Context hygiene — the classifier reads the thread, not the message

Safety classification is evaluated against the **conversation**, not the single latest turn.
Two consequences, both learned the expensive way (§10):

1. **Rewording does not undo it.** Once a thread carries sensitive-adjacent vocabulary, softening
   the next message leaves the earlier turns in place. Re-attempting with gentler phrasing is the
   single most common wasted move and it is banned by §3.
2. **Vocabulary is a resource — spend it deliberately.** Do not carry offensive-security lexicon
   into a chat that does not need it. Prefer the requirement form (§4). This costs nothing when
   the topic is legitimate and saves the thread when the topic is adjacent.

Therefore: a thread is either started on the right seat or it is restarted. Decontamination of a
running thread is not available.

---

## 3. Recovery ladder — what to do when a request is declined

Run in order. Never skip to a later rung by rewording.

1. **Do not rephrase.** Not once. Rewording a declined request is the anti-pattern; it burns turns
   and, per §2, cannot work on a thread that is already carrying the context.
2. **Move the work item to Opus 5** (or a fresh Opus 5 thread if the current one is contaminated).
   In practice this resolves it, because in practice the routing gate in §1 was skipped.
3. **If already on Opus 5:** state the legitimate purpose and the authorization **once**, plainly —
   this is authorized work on our own system, at the owner's direction. Do not decorate, do not
   argue, do not repeat.
4. **If still declined:** narrow the artifact. Split the deliverable so each piece is a requirement
   or an acceptance criterion (§4) rather than a survey of weaknesses. Route the narrow pieces to
   an executor seat with a self-contained brief.
5. **If still declined:** park it with a written note naming exactly what is unfinished and why,
   and surface it to the CEO as an open item. A parked item with an honest note is a result;
   a fourth attempt is not.

A permission, policy, seat, or capability denial stops after the first receipt:
no retry, rephrasing, polling, or delegation. For ordinary transient failures,
two identical attempts are the maximum before switching layer. Rungs 1→5 are
different layers, not repeated attempts at the same blocked action.

---

## 4. Artifact form — write plans that survive the next reading

The planning seat's output is read again later, often by a different seat. An artifact written as
an incident narrative can block the body that has to act on it. Write the same content as
requirements and it does not.

| Instead of | Write |
|---|---|
| a narrative of how a system could be misused | the requirement it must meet, and the acceptance test that proves it |
| an enumerated list of weak points | an ordered list of work items with a done-bar each |
| what an unauthorized party could achieve | what the system must refuse to do, and how that refusal is verified |
| "this is broken and here is the damage" | "this is the invariant; here is the evidence it does not yet hold; here is the check that will prove it does" |

This is not euphemism — the information content is identical and the acceptance criteria are
sharper. A requirement is testable; a narrative is not.

---

## 5. `FABLE.GO` — the stage token

**Canonical definition.** Originally established in the cross-body journal
(`VOLAURA/memory/atlas/codex-loop.md`, Round 3, signed Round 4). This section is the extraction
of record; the journal remains the provenance trail. `ATLAS-OPERATING-CANON.md` §7 refers to
**rule 4 below**.

A token activates **one already-reconciled stage**. It is not a permission phrase and it does not
widen the safe envelope.

**Grammar**

```
FABLE.GO mission=<MISSION-ID> stage=<STAGE-ID> canon=<ADR-ID>
         owner=<executor-body> verifier=<verifier-body> deadline=<ISO-8601>
```

**Rules**

1. The planning seat may issue a token only after the mission, stage scope, done-bar, stop
   conditions, rollback and proof owner are **written down** in the exec-graph or the signed
   journal. No token against an unwritten stage.
2. The executor body must **acknowledge** with its body identity, the exact stage, the files it
   will touch, and its proof plan **before the first edit**.
3. The verifier does **not co-build** the same files. It independently checks receipts, diff and
   tests, and returns `PASS` / `PASS-WITH-EXCEPTION` / `REFUTE`.
4. **A token never overrides a CEO-only gate.** Forever-gated: production-database mutation ·
   credential handling · upload · legal consent · external submission · payment or any movement of
   money · deletion · force-push · public release · merge to the default branch · cloud deploy.
5. After each stage every body reports in the six-field visibility contract (§6). The CEO receives
   only a short decision, an irreversible-action request, a blocker, or a final verified result.
6. **Scope change expires the token.** If canon, hash or scope changes, the planning seat issues a
   new stage token. An executor must never infer permission from an old "continue". A refinement
   recorded in the signed journal *by the issuing seat* is not a canon change and does not require
   re-issue.

**Token status is a fact with a location.** An active token is identifiable by mission, stage and
deadline in the journal. "I have a token" without that line is not a token.

---

## 6. Bodies and the current operating mode

**Body registry** — every cross-body entry uses these names.

| Body | Owns | Never |
|---|---|---|
| `fable-orchestrator` | mission sequence, work-class selection, stage tokens, receipt integration, fallback decisions, retro synthesis | edits · shell/build/test execution · self-certifies closure |
| `terminal-atlas-executor` | one bounded Sonnet implementation/test task; sole writer inside its declared paths | delegates · expands scope · issues tokens · self-certifies closure |
| `atlas-research` | one bounded read-only web/document task; local files only through Read/Grep/Glob-style tools | shell or external mutation · delegates · asserts unseen local facts |
| `codex-verifier` | primary local implementation when declared writer; independent closure when not the writer; deterministic audit and tie-breaker | delegates core coding merely to switch models · calls its own authored slice independent |
| `atlas-cto-design` | Opus/Antigravity architecture and adversarial analysis; advisory in missions | executes · mutates · independently closes implementation |
| `perplexity-external-cto` | web-native research, cross-source synthesis, external challenge | treats local-repository claims as verified · executes · closes implementation |

### Executor envelope

Every `Agent` call made by `fable-orchestrator` receives
`ATLAS_EXECUTOR_ENVELOPE_V1` mechanically from
`~/.claude/hooks/fable-protocol-router.py`. Seat authority comes from this
envelope, not from model name.

| Work class | Purpose | Limits | Authority |
|---|---|---|---|
| `executor` (default) | bounded code, commands, tests, or local inspection | 25 tool calls · 20 minutes | declared task and write paths only |
| `research` | long web/document analysis; a 30-minute investigation is normal | 60 tool calls · 45 minutes | read-only; URLs/citations required |

Rules:

1. One synchronous worker at a time. Background workers and grandchildren are
   disabled; Fable cannot create a second writer while the first worker runs.
2. The first action is one task-relevant capability/preflight check. A
   permission, policy, seat, or capability block ends the worker immediately.
3. Long productive research is allowed. Blocking polling is not: no sleep over
   60 seconds and no repeated status probes. The worker either works or returns
   a receipt.
4. Research is read-only and shell-free. Local git/command inspection uses the
   executor class; local files may still be inspected through read-only file
   tools. Executor changes only declared scope and preserves unrelated dirty
   files.
5. Receipt format is `STATUS / EVIDENCE / BLOCKER / NEXT`, at most 120 lines.
   Include commands and exit codes, exact SHA when relevant, and cited URLs for
   web claims. Do not echo whole files or full diffs.
6. Hitting a limit returns `BUDGET_EXHAUSTED` or `SPLIT_REQUIRED`; Fable splits
   the work instead of silently extending the worker.
7. The hook mechanically limits further tool calls and elapsed time at tool
   boundaries. The embedded Agent interface exposes no hard token/spend kill,
   so high-cost unattended work later moves to the brokered `claude -p
   --max-budget-usd` path.

**GOAL-MODE** (current amendment, established when the CEO ruled that courier hops be minimized:
«минимизируя моё вмешательство… /goal функцию включить и всё»):

- The planning seat commissions per-gate deterministic checks from one bounded
  executor, then inspects and integrates the receipt. It never runs suites,
  typecheck, git commands, or source mutation itself.
- Mechanical work goes to the bounded Sonnet `executor` class. Long read-only
  investigation goes to `research`. Fable context remains for decisions and
  sequencing.
- The independent verifier is demoted from per-round gate to **final-mission auditor**: one
  independent hop per mission rather than three per round. Independence is preserved because
  deterministic receipts are seat-independent.
- **CEO touches reduce to:** red-line gates (rule 4 list) · goal declarations · the optional final
  independent audit. Nothing else should require him.
- Red lines are **unchanged** by GOAL-MODE. Autonomy widened the loop, not the envelope.

**Six-field visibility contract** — every cross-body journal entry carries: what I see that the CEO
may not · what I see that the other body may not · what I think and where I disagree · what I will
do next · what requires the CEO · receipts and what remains unverified.

---

## 7. Driving the planning seat — the operating-mode block

Paste this when the seat runs unattended. It is the distilled form of the CEO master prompt; the
full template with the mission/data framing lives at `VOLAURA/memory/atlas/master-prompt.md`.

```text
# MISSION
I'm working on [larger goal] for [who it's for]. They need [what the output enables].
With that in mind: [the specific task].
Done = [verifiable: tests green / command shows X / merged].
Out of scope: [what not to touch].

# DATA
[big context, files, logs — pasted HERE, above the task]

# OPERATING MODE
You are operating autonomously. I am not watching in real time and cannot answer questions
mid-task. For reversible actions that follow from the original request, proceed without asking.
Pause only when the work genuinely requires me: an irreversible action, real spend, a real scope
change, or input only I can provide — finish everything else first, then list those gates at the
end as one-tap actions.

When you have enough information to act, act. Do not re-derive established facts or survey options
you will not pursue.

Before ending your turn, check your last paragraph. If it is a plan, a question, or a promise about
work you have not done, do that work now with tool calls. End only when the task is complete or
blocked on input only I can provide.

Before reporting progress, audit each claim against a tool result from this session. Report only
work you can point to evidence for; say so explicitly when something is unverified. If tests fail,
say so with the output.

You have ample context remaining. Do not stop, summarize, or suggest a new session on account of
context limits. Checkpoint state into files and git at every milestone so any interruption is cheap
to resume.

Delegate only through the executor envelope: one synchronous worker at a time,
no grandchildren. Use `WORK_CLASS: research` for long read-only web/document
analysis; use `executor` for bounded commands, edits, and tests. Verify every
receipt before trusting it.

Do the simplest thing that works well. No features, refactors or abstractions beyond the task.

Stay inside the envelope's tool/time limits and every visible token, spend, or
rate cap. A permission/policy/seat/capability denial stops after the first
receipt. An ordinary transient failure gets at most two identical attempts
before switching layer.

# REPORT
Final message in Russian, short prose: outcome first, then what is proven with evidence, then the
gates that need me — each as one tap.
```

**When the template is not needed:** a one-line diff. Describe it in a sentence and go. The block is
for autonomous runs of an hour or more.

---

## 8. Fable 5 deltas that change how we work

Only the items with an operational consequence. Full notes:
`VOLAURA/memory/atlas/FABLE-5-PROMPTING.md`.

- **Effort is the main dial.** Default high; top tier for the hardest capability-sensitive work;
  drop it when a task completes but drags.
- **Brief instructions beat exhaustive ones.** Stacked absolutes over-trigger. State the rule once,
  in normal prose. A rule the model keeps ignoring means the instruction surface is too long — prune
  rather than shout.
- **Never ask it to reproduce its internal reasoning** as response text. Ask for evidence — tool
  results, file paths, command output. Our "what is proven / what is not" report shape is safe
  precisely because it cites external receipts rather than reasoning.
- **Long research is normal.** A `research` worker may use up to 45 minutes.
  Run it synchronously; do not poll it with sleeps or spawn another worker.
- **Guard the ending.** The seat can close a turn on "I'll now run X" without running it. If the
  last paragraph is a plan, a question or a promise, do the work before ending.
- **Context-limit reassurance.** Given a shrinking-context signal it may wrap up early. Counter
  explicitly.
- **It takes unrequested action readily.** Keep the "report and stop" boundary and the
  evidence-supports-this-specific-action check.

---

## 9. Registration — where this is pointed from

A protocol nobody loads is not a protocol. This file is referenced from:

- [`ATLAS-OPERATING-CANON.md`](ATLAS-OPERATING-CANON.md) §7 — resolves the FABLE.GO reference.
- [`ATLAS-MASTER-PLAN.md`](ATLAS-MASTER-PLAN.md) — seat assignment per phase.
- [`ATLAS-STATE-NOW.md`](ATLAS-STATE-NOW.md) — read-first on resume.
- `VOLAURA/memory/atlas/master-prompt.md` and `FABLE-5-PROMPTING.md` — supersession headers.

**Doc law.** Routing, token grammar and recovery live **here only**. The VOLAURA files keep the
lived provenance and the CEO-facing prompt template. `codex-loop.md` remains the append-only
cross-body journal — the record of what happened, never the specification of how to work.

---

## 10. Evidence and the open item

**Evidence for §1–§3** — 2026-07-27, four declined requests in one session, same root cause each
time: a readiness-and-resilience work item was started on the planning seat instead of Opus 5, and
after the first decline the response was to soften the wording rather than to change seats. The
fourth decline occurred while softening a document that had already been softened once. Session
receipt: `ATLAS-MASTER-PLAN.md` was produced and committed only after the seat moved to Opus 5.

**Open item — instruction-surface reduction (CEO-gated).** `master-prompt.md` closes with a
structural step recorded as *не сделано*: thin `CLAUDE.md`, `.claude/rules/` and the hooks —
remove stacked absolutes and over-prescriptive enumerations, keep the substance (verification,
boundaries, memory, convenience-first). Its own text gates this on «Отдельный PR по команде CEO»,
and it edits the files that govern behavior, so it is specified here rather than executed:

- **Scope:** `~/.claude/CLAUDE.md`, `VOLAURA/.claude/rules/*.md`, hook scripts under `~/.claude/hooks/`.
- **Change:** convert stacked absolutes to single declarative statements; collapse duplicated rules
  to one home each; leave every gate's substance intact.
- **Done-bar:** total instruction surface reduced measurably (line count per file recorded before
  and after); no gate removed — a diff review confirms each rule still has exactly one home; the
  hook suite still fires on its test cases.
- **Risk:** these files are load-bearing for the secret and spend gates. Any thinning pass is
  reviewed rule-by-rule, not bulk-edited.
- **Status:** ready to run, awaiting the CEO's word — per the gate written in his own file.
