# SPEC-PORTABLE-LESSONS-LEDGER — runtime lessons mechanism for embedded Atlas

> **Status:** DRAFT · 2026-07-23 · author `atlas-cto-design`. Drafted by a Sonnet hands-agent; every file:line citation independently re-verified by atlas-cto-design against HEAD `69b861f`.
> **Deliverable:** D2, `docs/atlas-cto/IMPLEMENTATION-PLAN-A1-2026-07-21.md:114` ("Portable lessons-ledger spec, A1.6 #3 runtime half").
> **Authority:** design-lane spec only — executor builds, `codex-verifier` verifies (per plan §C). Not binding until an executor session lands the code and a PASS verdict is recorded.
> **Ties to:** `docs/atlas-cto/ATLAS-OPERATING-CANON.md:57-58` ("Lessons ledger — where lived lessons live"), which promises exactly this mechanism for a standalone-embedded Atlas and is honored, not restated, here. Sibling spec: `SPEC-M8-EVIDENCE-AUDIT.md` (D1) — owns the canonical typed-claim vocabulary this spec adopts (see Schema note below).

## Purpose

`ATLAS-OPERATING-CANON.md` §0 (`ATLAS-OPERATING-CANON.md:8`) states the one axis: prose fails under pressure, only a structural gate holds. When Atlas is embedded standalone (ADR-0009, `docs/adr/0009-vision-canon-portable-agent-factory.md:9`), it needs a place to record ITS OWN new lessons — failures observed in that deployment, not VOLAURA's — using the same gate-or-GATE-PENDING discipline the canon itself follows. This spec defines that mechanism: an append-only local ledger, schema-compatible with the evidence typing of A1.6 #3, that any embedded Atlas can write to without needing VOLAURA, without touching exec-graph state, and without becoming a new home of canon.

## Non-goals

- **Not a third canon home.** ADR-0009 A1.4 (`docs/adr/0009-vision-canon-portable-agent-factory.md:63`) is exactly two homes: ANUS `docs/` = decision/architecture canon, VOLAURA `memory/atlas/` = lived memory. This ledger is a **runtime artifact of one deployment** — it never gets read as canon by another deployment and never gets pushed into `docs/`. A lesson graduates to canon only by a human editing `ATLAS-OPERATING-CANON.md` directly; this ledger has no write path there.
- **Not the self-compiling wiki.** ADR-0009 A1.6 #5 names a future consumer that reads ledgers like this one and compiles them into something larger. That consumer does not exist; this spec only produces the data it would eventually read.
- **Not cross-instance/cross-deployment sync.** Per A1.4's "no third home," lessons never sync automatically between deployments or back to VOLAURA. A future federated-lessons mission is out of scope and explicitly deferred (see Open Questions).
- **Not built by this document.** This is design-lane; an executor session implements it against the acceptance criteria below.
- **Not a fork of the evidence schema.** `SPEC-M8-EVIDENCE-AUDIT.md` (D1, landed the same day as this spec) owns the canonical A1.6 #3 typed-claim schema (`claim/type/path/confidence`, `claimTypeSchema` derived from `src/hands/contract.ts:52-59`'s `receiptKindSchema` + `audit-finding`). This spec's `EvidenceRef` **adopts that vocabulary at build time** — see the reconciliation note in the Schema section. It does NOT fork exec-graph's separate `evidenceKindSchema` (`src/exec-graph/contracts.ts:67`), which stays graph-only.

## Schema

**Reconciliation note (atlas-cto-design, 2026-07-23).** The hands-agent draft of this spec originally mirrored exec-graph's `evidenceKindSchema` (`commit|test-output|file|url|tool-receipt|other`); D1's canonical `claimTypeSchema` is receipt-derived (`file-exists|commit-exists|file-contains|command-output-match|browser-action|narrative|audit-finding`). Two A1.6 #3 vocabularies would be exactly the fork both specs forbid. Ruling: **`EvidenceRef.type` uses D1's `claimTypeSchema`** (imported from the evidence module M8 builds, or a local copy carrying a `// MUST match SPEC-M8-EVIDENCE-AUDIT §3.1` marker until M8 lands). Lessons-evidence that predates M8 may use `narrative` with `confidence: 0` per D1 §3.2 — honest, replayable later.

```ts
// src/atlas/lessons-ledger/contracts.ts — PROPOSED, not yet built.

/** class-<n> or class-<n>-<slug>. Enforced unique at append time — see Storage layout. */
export type LessonClassId = string;

/**
 * Per canon §0: a lesson without a structural gate reference is GATE-PENDING.
 * No free-text "trust me, there's a rule" option — either a concrete
 * enforcement point is named, or the field says so honestly.
 */
export type StructuralFixRef =
  | { kind: 'gate-pending' }
  | { kind: 'hook'; ref: string }        // e.g. a pre-commit / pre-tool-use hook script path
  | { kind: 'middleware'; ref: string }  // e.g. 'src/hands/exec-graph-adapter.ts:126-137 assertReceiptHasNoSecrets()'
  | { kind: 'verifier'; ref: string }    // e.g. 'src/hands/verifier.ts', 'src/exec-graph/verifier-port.ts'
  | { kind: 'ci-gate'; ref: string };    // e.g. '.github/workflows/ci.yml build+tsc+vitest job'

/**
 * SAME core schema as ADR-0009 A1.6 #3 — {claim, type, path, confidence}.
 * `type` = D1's claimTypeSchema (SPEC-M8-EVIDENCE-AUDIT §3.1/§3.4), NOT
 * exec-graph's evidenceKindSchema. One claim vocabulary for A1.6 #3, no third.
 */
export interface EvidenceRef {
  claim: string;
  type: ClaimType;     // import type { ClaimType } — D1 §3.1 vocabulary
  path: string;        // file path, URL, commit SHA, or receipt ref
  confidence: number;  // 0-1; D1 §3.2 anchor points; FP-penalty registry (D1 §5) may downweight AT READ — registry itself is NOT D2 scope
}

export interface LessonEntry {
  entryId: string;              // uuid, one per append (not the same as classId)
  classId: LessonClassId;
  title: string;
  symptom: string;
  pathway: string;               // root cause, not the symptom restated
  structuralFix: StructuralFixRef;
  recurrenceCount: number;       // 1 on first record of a classId; see Recurrence detection
  date: string;                  // ISO 8601 — see Open Questions #1 (recorded-date vs incident-date)
  sourceDeploymentId: string;    // opaque id of the embedded Atlas instance; portable, never a VOLAURA/CEO identifier
  evidenceRefs: EvidenceRef[];   // >=1 required, always — including seed entries (see Seeding). Mirrors exec-graph's own invariant: a verified/closed task must carry >=1 evidence entry.
  seed: boolean;                 // true only for canon-derived seed entries
}

/** Envelope shape copied from src/exec-graph/contracts.ts's LedgerEvent idiom (eventId/kind/ts/actor/payload) — same idiom, new kinds. */
export type LessonLedgerEvent =
  | { eventId: string; kind: 'lesson-recorded'; ts: string; actor: string; payload: { entry: LessonEntry } }
  | { eventId: string; kind: 'lesson-recurred'; ts: string; actor: string; payload: { classId: LessonClassId; entryId: string; recurrenceCount: number; evidenceRefs: EvidenceRef[] } };
```

`classId` format is deliberately restrictive (`/^class-[0-9]+(-[a-z0-9-]+)?$/`) for the same reason `exec-graph`'s `gol_`/`tsk_` id prefixes exist (cited by ADR-0003 `docs/adr/0003-append-only-ledger-plus-snapshot.md:67-68`): it makes path-traversal and dunder-key injection unparseable at the schema layer, not just discouraged by convention.

## Storage layout

Reuses ADR-0003's append-only-ledger-plus-snapshot pattern (`docs/adr/0003-append-only-ledger-plus-snapshot.md`) verbatim — no new persistence idiom:

- **Directory:** `state/lessons-ledger/` — a sibling of, and structurally separate from, `state/exec-graph/`. Resolved by a proposed `resolveLessonsLedgerDir()` mirroring `resolveExecGraphDir()` (`src/exec-graph/ledger.ts:83-100`): env override first (`ATLAS_LESSONS_LEDGER_DIR`, naming convention matching `ATLAS_EXEC_GRAPH_DIR`), then cwd-if-repo-root, then module-walk fallback.
- **`lessons-ledger.jsonl`** — source of truth. Append-only, one `LessonLedgerEvent` JSON object per line. Same fail-safe read contract as `readLedgerEvents()` (`src/exec-graph/ledger.ts:196-232`): a malformed or schema-invalid line is skipped + `console.error`'d, the rest of the file still loads, reads never throw.
- **`lessons-snapshot.json`** — derived, disposable: `{ entries: Record<LessonClassId, LessonEntry> }`, rebuildable at any time by folding the ledger (mirrors `foldEvents()`/`rebuildSnapshot()`). A `lesson-recorded` event sets/creates the entry; a `lesson-recurred` event bumps `recurrenceCount` and appends its `evidenceRefs` onto the existing entry's `evidenceRefs` array (never overwrites `symptom`/`pathway`/`structuralFix` — those are corrected by editing canon, not by rewriting history).
- **Writes are loud-but-non-fatal**, same as `persistEvent()` (`src/exec-graph/ledger.ts:296-318`): a failed append `console.error`s and returns before the snapshot write is attempted.
- **Git posture — deliberate divergence from ADR-0003.** `state/exec-graph/` is git-tracked (ADR-0003 Decision: "both git-tracked"), because it is the ANUS project's own single shared execution authority. `state/lessons-ledger/` must NOT be — it is per-deployment local state, and git-tracking it inside the ANUS repo would make every embedding's lessons land back in the shared repo, which is precisely the "third home" A1.4 forbids. `.gitignore` already has precedent for excluding specific `state/` subdirectories while leaving `state/exec-graph/` tracked (`.gitignore:38-40`: `state/swarm-runs/`, `state/intake-drafts/`, `state/smoke-exec-graph/`) — add `state/lessons-ledger/` to that list.

## Seeding

On first boot of an embedded Atlas (no `lessons-snapshot.json` present), a build/boot step seeds the ledger from `ATLAS-OPERATING-CANON.md` §0-7. **§8 is excluded** — canon's own text calls it "the ONE section that re-skins" per deployment (`ATLAS-OPERATING-CANON.md:51`); its bullets are operator-interface config, not portable lessons.

Mechanism (PROPOSED, e.g. `scripts/seed-lessons-from-canon.mjs`, not yet built): parse each top-level `- ` bullet under §0-7 as one seed candidate. Counted from the current file: §0 = 1 (the meta-axis paragraph itself), §1 = 6, §2 = 3, §3 = 4, §4 = 4, §5 = 3, §6 = 3, §7 = 4 — **28 seed candidates total**. Each becomes a `LessonEntry` with `seed: true`, `sourceDeploymentId` = this deployment's id, and a single self-referential `evidenceRefs` entry: `{ claim: '<bullet text>', type: 'file-contains', path: 'docs/atlas-cto/ATLAS-OPERATING-CANON.md', confidence: 1 }` (D1 vocabulary; `expectedSubstring`-style replayability is exactly why the receipt-derived vocabulary wins here — an auditor can re-check that the canon still says what the seed claims).

`structuralFix` at seed time is set to a real reference **only** where an ANUS-repo mechanism genuinely exists today; two verified examples:
- The §1 evidence/closure bullets → `{ kind: 'verifier', ref: 'src/exec-graph/contracts.ts transitionSchema superRefine + task evidence invariant: verified/closed tasks require >=1 evidenceRefs' }`.
- The §5 secret-byte-gate bullet (`ATLAS-OPERATING-CANON.md:37`) → `{ kind: 'middleware', ref: 'src/hands/exec-graph-adapter.ts:106-114 SECRET_SHAPE_PATTERNS + assertReceiptHasNoSecrets(), enforced before submitReceipt() persists' }`.

Every other bullet's canon citation (e.g. "ADR-015", "Class 35/43", "ADR-013") points at VOLAURA's own ADR/lesson numbering, not an ANUS file — confirmed by `ls docs/adr` returning only `0001`-`0009` in this repo. Those seed as `{ kind: 'gate-pending' }`. This is expected and correct, not a defect: an ANUS-only embedding genuinely has not wired VOLAURA-side enforcement, and the ledger should say so rather than borrow a citation that doesn't resolve to a file here. (One canon citation is itself ambiguous and worth a maintainer look, not a blocker: `ATLAS-OPERATING-CANON.md:46` cites "ADR-008 pattern" for a governance/audit ledger, but ANUS's own ADR-0008 is a different topic — the citation is to VOLAURA's ADR-008, which this seeding step cannot resolve automatically.)

**Idempotency:** re-running the seed step against an already-seeded ledger must be a no-op, not a `lesson-recurred` event — a rebuild/redeploy re-observing the same canon text is not a new occurrence of the failure. Enforced the same way `appendEvent()` dedupes `task-created` by `idempotencyKey` (`src/exec-graph/ledger.ts:339-345`): before writing, check whether a `seed: true` entry with this exact `classId` already exists in the current snapshot; if so, skip silently.

## Recurrence detection and operator-brief integration

When `recordLesson()` is called with a `classId` that already has an entry in the snapshot, it appends a `lesson-recurred` event (not a duplicate `LessonEntry`) and the fold increments `recurrenceCount`.

**This is a real, observed need, not speculative.** `VOLAURA/memory/atlas/lessons.md` currently has two entries both titled "Class 59" — one at line 749 (env-parity, 2026-07-07) and a different one at line 758 (CRLF Edit-tool matching, 2026-07-09). That file has no machine enforcement of class-id uniqueness; this schema does (see Negative tests #3). (Re-verified 2026-07-23 by atlas-cto-design: both lines present.)

**Brief integration point** (`src/atlas/cos/brief.ts`): `BriefCategory` is a closed union of six values fed by `composeCosBriefItems(facts, drift)`, where `drift: readonly DriftFinding[]` comes from `src/atlas/cos/drift.ts`. `DriftFinding` (`drift.ts:15-22`) has a closed `DriftKind` union (`drift.ts:11`: `'unpushed-commits' | 'graph-verify-failed' | 'stale-heartbeat' | 'stuck-task'`). The clean integration is: **do not add a new `BriefCategory`** — extend `DriftKind` (`drift.ts:11`) with `'lesson-gate-pending' | 'lesson-recurring'`, and have a new lessons-ledger drift detector emit `DriftFinding`-shaped records (`sourceAuthority: 'lessons-ledger'`, `ref: classId`, `severity: 'drift'`, `evidenceFreshness`, `reason`). Fed into the existing `drift` array, these route through `driftFindingsToBriefItems()` unchanged and land under **`DRIFT / STALE SIGNAL`** — both a `gate-pending` entry (canon promises a gate, none exists) and a `recurring` entry (a gate existed and the pathway won anyway) are, semantically, exactly what that category already means: a detected divergence between claimed and actual discipline. This requires one small, explicit code change (`DriftKind`'s union) for the executor to make — not a `brief.ts` contract change.

## Acceptance criteria (executor DONE-bar)

1. `npx vitest run src/__tests__/lessons-ledger.test.ts` — green. Must include a fold-equals-rebuild check: incremental snapshot update after N appends == full fold from scratch, mirroring the equality ADR-0003 calls out for `atlas graph verify`.
2. A CLI command (proposed `atlas lessons verify`, mirroring `atlas graph verify`) rebuilds the snapshot from `lessons-ledger.jsonl` and diffs it against on-disk `lessons-snapshot.json`; exits non-zero on mismatch.
3. Seed step run twice against a fresh `state/lessons-ledger/` dir → `wc -l lessons-ledger.jsonl` identical after both runs (idempotent seed, no duplicate seed lines).
4. `recordLesson({classId: 'class-999', ...})` called twice with the same `classId` → snapshot shows `recurrenceCount === 2`, and `wc -l lessons-ledger.jsonl` shows exactly 2 new lines (one `lesson-recorded`, one `lesson-recurred`), not two full `LessonEntry` duplicates.
5. With one `gate-pending` and one `recurring` lesson present, the lessons-drift detector's output, fed into `composeCosBriefItems`, produces `BriefItem[]` entries with `category === 'DRIFT / STALE SIGNAL'` (assert via a test in the style of the existing cos drift tests).
6. Import-boundary check (CI-enforceable one-liner): `grep -rn "exec-graph/ledger" src/atlas/lessons-ledger/` returns zero matches.
7. Portability check: `grep -rniE "volaura|ganbarov|\bceo\b" src/atlas/lessons-ledger/*.ts` returns zero matches in runtime code (comments citing provenance in this spec doc are exempt; the code itself is not).

## Negative tests

1. **Duplicate seed** — run the seed step twice; assert no new `lesson-recorded` events for already-seeded `classId`s (see Acceptance #3). Mirrors `appendEvent()`'s `task-created` idempotencyKey dedup.
2. **Tampered entry** — hand-edit one line of `lessons-ledger.jsonl` to invalid JSON, and separately to valid JSON failing schema (e.g. `confidence: 2.5`); assert `readLessonLedgerEvents()` skips + logs both cases and still returns every other valid event. Mirrors `readLedgerEvents()`'s malformed-line handling (ADR-0003 read-path guarantee).
3. **classId collision with different content** — call `recordLesson()` twice with the same `classId` but different `title`/`symptom` outside the recurrence path (i.e. attempting to silently overwrite an existing entry's narrative instead of recurring it) — must be rejected. This is the machine-enforced fix for the real defect found in `VOLAURA/memory/atlas/lessons.md:749` and `:758` (two unrelated lessons both filed as "Class 59").
4. **Exec-graph write isolation** — hash `state/exec-graph/ledger.jsonl` and `state/exec-graph/graph.json` before and after N calls to `recordLesson()`; assert byte-identical. Proves the lessons-ledger cannot touch exec-graph state even by accident, not just by convention (backed by Acceptance #6's static import-boundary check).
5. **Path-traversal / dunder-key classId** — attempt `recordLesson({classId: '../../exec-graph/ledger', ...})` and `recordLesson({classId: '__proto__', ...})` — both rejected by the `classId` format regex before any file write is attempted. Mirrors `isSafeKey()`'s dunder-key defense.
6. **Secret-shaped lesson content** — attempt `recordLesson()` with a `symptom` or `evidenceRefs[].claim` field matching the existing `SECRET_SHAPE_PATTERNS` family (`src/hands/exec-graph-adapter.ts:106-114`) — rejected before persist, never reaches `lessons-ledger.jsonl`. Reuses the existing regex set rather than inventing a second one; a ledger built to record leak-avoidance lessons must not itself become a leak vector.

## Open questions (max 3)

1. **`date` semantics.** Is `LessonEntry.date` the moment-of-recording (always knowable, always honest) or an asserted incident date (more useful for postmortems, but a claim the deployment may not be able to verify)? VOLAURA's `lessons.md` uses incident date in its headers throughout. Proposed default: recording-moment only, with an optional future `incidentDate?: string` field left for D1's evidence-confidence machinery to arbitrate — not resolved here.
2. **Does a `lesson-recurred` event need fresh evidence, or may it inherit the original entry's?** The schema above requires `evidenceRefs` on the recurrence event itself (treating "it happened again" as its own claim needing its own proof), but this roughly triples the friction of surfacing a recurrence versus letting it inherit the original entry's evidence. Not resolved — affects whether Negative test #3's collision guard needs an evidence-completeness check too.
3. **Graduation path.** A1.4 forbids automatic cross-deployment sync, but says nothing about a human manually reading a deployment's `gate-pending`/high-`recurrenceCount` lessons and hand-porting the good ones into `ATLAS-OPERATING-CANON.md`. Is that graduation path itself worth a light-touch export command (e.g. `atlas lessons export --format=canon-bullet`) in D2's scope, or is it explicitly the "future federated-lessons mission" the non-goals section defers? Leaning toward: out of scope for D2, name it as the first candidate for that future mission.
