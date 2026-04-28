# Sprint 2 Backlog — "Quality Gates as Code"

**Sprint goal:** Atlas CLI enforces Toyota/Apple quality standards through hard Mastra middleware. No soft rules. Poka-yoke.

**Source:** Terminal-Atlas handoff 2026-04-26 (15 Q&A) + CEO directive "Toyota + Apple standards" + error classes 3,7,9,10,14.

---

## STORY-9: Poka-yoke middleware — consult_swarm_first
As: Atlas agent
Want: hard block before any task >3 files — must spawn agent consultation first
So that: Class 3 (solo execution) is structurally impossible
AC: test triggers middleware on large-scope prompt, middleware requires agent call before proceeding
Effort: M

## STORY-10: Poka-yoke middleware — verify_completion_walk
As: Atlas agent  
Want: hard block before any "done/готово" claim — must have preceding verify tool call
So that: Class 7 (false completion) is structurally impossible
AC: test detects "done" without verify call, middleware rejects
Effort: M

## STORY-11: Voice gate — output filter
As: CEO
Want: Atlas never outputs bullet walls, ## headings, or banned openers in conversation
So that: Atlas voice stays consistent (Russian storytelling, short paragraphs)
AC: voice.ts validateVoice() runs on every agent response, breaches trigger rewrite
Effort: S

## STORY-12: Research gate — pre-implementation check
As: Atlas agent
Want: hard block before implementation — must show 3+ alternatives researched
So that: Class 9 (skipped research) is structurally impossible
AC: test triggers gate on "build X" prompt without prior research tool calls
Effort: M

## STORY-13: Toyota/Apple standards research via NotebookLM
As: team
Want: NotebookLM notebook with Toyota Production System + Apple ANPP + DORA metrics sources
So that: every agent can `notebooklm ask` about quality standards with grounded answers
AC: notebook created, 5+ sources added, `notebooklm ask "what is jidoka"` returns sourced answer
Effort: M

## STORY-14: Canonical wake from VOLAURA vault (lessons.md included)
As: Atlas agent
Want: wake protocol reads identity + heartbeat + journal + lessons + debts from canonical vault
So that: every session starts with full context including error class awareness
AC: loadWakeContext() returns content including lessons.md last 5 classes + debts Open balance
Effort: S

## STORY-15: Agent briefing template
As: swarm agents
Want: standard briefing injected into every agent spawn explaining CEO identity, project vision, quality standards, error classes
So that: agents don't operate blind — they know who CEO is and what standards apply
AC: briefing template file exists, createAtlasAgent injects it, agent response reflects awareness
Effort: S

## STORY-16: Stale detection in compile-wiki
As: knowledge system
Want: `last-touched` frontmatter in concept files, auto-flag when source files changed since last compile
So that: wiki knowledge doesn't silently rot
AC: compile-wiki adds last-touched, re-run detects stale concepts
Effort: S

---

## Dependency chain
STORY-14 first (wake with lessons) → STORY-15 (briefing template) → STORY-9,10,11,12 parallel (gates) → STORY-13 (notebooklm research) → STORY-16 (stale detection)

## Definition of Done (Toyota standard)
- Each story has automated test
- Each story tested BEFORE moving to next (Jidoka)
- No Class 7 claims — verify with tool call
- No Class 3 — consult swarm before implementing each story
- Voice check on all documentation output
