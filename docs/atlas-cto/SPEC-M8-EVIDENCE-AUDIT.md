# SPEC-M8-EVIDENCE-AUDIT — typed-claim evidence ledger + read-only auditor

- **Status:** DRAFT-FOR-M8
- **Date:** 2026-07-23
- **Author:** atlas-cto-design (spec-only; per `docs/atlas-cto/IMPLEMENTATION-PLAN-A1-2026-07-21.md` §C deliverable D1). Drafted by a Sonnet hands-agent, every file:line citation below independently re-verified by atlas-cto-design against HEAD `69b861f`.
- **Consumers:** M8 module executor (builds this), codex-verifier (verifies the build against this spec), `SPEC-PORTABLE-LESSONS-LEDGER.md` (D2 — adopts this spec's typed-claim core, see §3.4).
- **Binds to:** ADR-0009 (`docs/adr/0009-vision-canon-portable-agent-factory.md`) Amendment A1.6 items #3 (evidence schema) and #4 (whistleblower/auditor agent); `docs/atlas-cto/ATLAS-OPERATING-CANON.md` §1/§2/§6; ADR-0003 (append-only ledger + snapshot); ADR-0006 (Hand Contract authority); ADR-0007 (deterministic verifier doctrine)

## 1. Purpose

Give the M8 executor a buildable spec for two things frozen mission scope asks for (codex-loop Round 18): "**M8 Evidence/Audit: Terminal Opus writer + ONE read-only auditor subagent (Sonnet) attempting stale-receipt replay and counter tampering. DoD adds: auditor's adversarial log attached.**"

1. **A typed-claim evidence ledger** at `state/evidence/` — the ADR-0009 A1.6 #3 mechanism (`claim/type/path/confidence` per finding + a false-positive penalty registry), built by extending the ADR-0003 append-only-ledger-plus-snapshot pattern, not inventing a parallel one.
2. **A read-only auditor** — the A1.6 #4 whistleblower agent — that replays recorded verifications against current ground truth and checks the ledger's own hash chain for tampering.

## 2. Non-goals

- **Not built now.** This is a spec; the M8 executor implements it; codex-verifier checks the implementation against it.
- **The auditor has ZERO authority.** It can never move an exec-graph task, never set `verified`/`rejected`, never block anything by itself. Its only effect on the world is appending findings a human or a verifier subsequently reads. This is Invariant I1 (`docs/atlas-cto/IMPLEMENTATION-PLAN-A1-2026-07-21.md` §1 goals: "only the deterministic verifier closes tasks") applied to a new actor.
- **Not a second verifier.** `src/hands/verifier.ts`'s `verify()` remains the one deterministic receipt checker (ADR-0007). The auditor *calls* `verify()` again against fresh state (§6, check 1) — it does not reimplement or compete with it.
- **Not a new authority system.** `state/evidence/` is a sibling non-authority store to `state/exec-graph/`, precedented by `state/swarm-runs/` (ADR-0007, `src/swarm-exec/run-bundle.ts`). It never contains task state and the auditor's own module never imports `src/exec-graph/api.ts` or `src/exec-graph/verifier-port.ts`.
- **No LLM calls in the auditor's checks.** Stale-receipt replay and hash-chain verification are both pure/deterministic, mirroring `hands/verifier.ts`'s "NO LLM, NO network" posture (`src/hands/verifier.ts:1-8`).
- **No VOLAURA-specific paths.** Everything below resolves relative to repo root the same way `exec-graph/ledger.ts`'s `resolveExecGraphDir()` does (`src/exec-graph/ledger.ts:83-100`) — portable per ADR-0009 A1's embeddability constraint.

## 3. Typed claim schema

### 3.1 Claim types

The frozen core (ADR-0009 A1.6 #3) is `{claim, type, path, confidence}`. `type` reuses `src/hands/contract.ts:52-59`'s `receiptKindSchema` values verbatim — this is deliberate reuse, not parallel invention, per the canon's "extend the one living doc/contract, don't fork it" discipline (`ATLAS-OPERATING-CANON.md` §3). One value is genuinely new.

```typescript
// EXTENSION-marked: only 'audit-finding' is new. The other six are
// hands/contract.ts:52-59's receiptKindSchema options, imported not copied.
export const claimTypeSchema = z.enum([
  'file-exists', 'commit-exists', 'file-contains',
  'command-output-match', 'browser-action', 'narrative', // == receiptKindSchema.options
  'audit-finding', // EXTENSION — produced ONLY by the auditor (§6)
]);
export type ClaimType = z.infer<typeof claimTypeSchema>;
```

**UNVERIFIED note:** the mission brief that produced this deliverable suggested example types `file-hash`, `test-count`, `url-fetch`. None of these exist anywhere in `src/hands/contract.ts` or `src/exec-graph/contracts.ts` today (grepped `receiptKindSchema` and `evidenceKindSchema` — neither module defines them). This spec does **not** invent them. `command-output-match` already covers "N tests passed" via `expectedSubstring` (see check 3, §6); a dedicated `test-count` type would duplicate that with no new verification power, so it is deliberately excluded, not overlooked.

### 3.2 Confidence scale

`confidence: number` in `[0, 1]`, continuous, not banded — but the auditor and executor should anchor writes to these points so the ledger is comparable across sources:

| Value | Meaning |
|---|---|
| `1.0` | Independently, deterministically verified — `hands/verifier.ts`'s `verify()` returned `{verified:true}` for this exact claim, OR an `audit-finding` claim's own conclusion (the finding is itself fresh ground truth at write time). |
| `0.7` | `verify()` returned `{verified:true}` at write time but has not yet been replayed by any auditor pass (default for a fresh receipt-backed claim). |
| `0.3` | Asserted but not independently checkable at write time (e.g. a swarm worker's raw synthesis text before any receipt exists for it). |
| `0.0` | `type === 'narrative'` (schema-forced, see below — mirrors `hands/verifier.ts:105-106`: `"narrative-only receipt has no independently checkable evidence"` → `verified:false`, always), OR `verify()` returned `{verified:false}`. |

**Schema-level forgery guard** (mirrors `exec-graph/contracts.ts:89-104`'s `transitionSchema.superRefine` cross-field pattern):

```typescript
.superRefine((c, ctx) => {
  if (c.type === 'narrative' && c.confidence > 0) {
    ctx.addIssue({ code: 'custom', path: ['confidence'],
      message: "type 'narrative' has no independently checkable evidence; confidence must be 0" });
  }
  // ...the file-contains/command-output-match/audit-finding field-presence rules below
})
```

### 3.3 Full interface

```typescript
export const claimIdSchema = z.string().regex(/^clm_[a-z0-9][a-z0-9._-]{1,80}$/);

export const auditVerdictSchema = z.enum(['confirmed', 'stale', 'tampered', 'count-mismatch']); // EXTENSION — only meaningful when type==='audit-finding'

export const typedClaimSchema = z.object({
  claimId: claimIdSchema,
  claim: z.string().min(1),          // FROZEN CORE — human-readable assertion, e.g. "state/evidence/ledger.jsonl round-trips"
  type: claimTypeSchema,              // FROZEN CORE
  path: z.string().min(1),            // FROZEN CORE — plays Receipt.ref's role (hands/contract.ts:69); for command-output-match, path is a free-text label, `command` (below) carries the real ref
  confidence: z.number().min(0).max(1), // FROZEN CORE
  // EXTENSION fields — each justified against an existing precedent, not invented loose:
  source: z.string().min(1),          // EXTENSION — 'hand:<handId>' | 'swarm:<workerId>' | 'auditor:<auditRunId>' | 'atlas'; the FP-registry key (§5)
  sourceRef: z.string().min(1).optional(), // EXTENSION — pointer back to the originating exec-graph taskId / swarm runId / (for audit-finding) the claimId being audited
  command: z.string().min(1).optional(),   // EXTENSION — required for command-output-match; MUST match hands/verifier.ts:70-79's READONLY_COMMAND_ALLOWLIST, same allowlist, not a second one
  expectedSubstring: z.string().min(1).optional(), // EXTENSION — required for file-contains/command-output-match, mirrors receiptSchema (hands/contract.ts:73)
  auditVerdict: auditVerdictSchema.optional(), // EXTENSION — required iff type==='audit-finding'
  ts: z.string().datetime(),
}).superRefine((c, ctx) => {
  // mirrors hands/contract.ts:81-127's receiptSchema.superRefine field-presence rules, 1:1 by type
  if (c.type === 'file-contains' && !c.expectedSubstring) { /* ...issue... */ }
  if (c.type === 'command-output-match' && (!c.command || !c.expectedSubstring)) { /* ...issue... */ }
  if (c.type === 'audit-finding' && (!c.auditVerdict || !c.sourceRef)) { /* ...issue... */ }
  if (c.type === 'narrative' && c.confidence > 0) { /* ...issue, see 3.2... */ }
});
export type TypedClaim = z.infer<typeof typedClaimSchema>;
```

### 3.4 Vocabulary reconciliation (atlas-cto-design review note, 2026-07-23)

Two receipt/evidence type vocabularies already coexist in this repo: exec-graph's `evidenceKindSchema` (`src/exec-graph/contracts.ts:67`: `commit|test-output|file|url|tool-receipt|other`) and hands' `receiptKindSchema` (`src/hands/contract.ts:52-59`, adopted above). **This spec's `claimTypeSchema` is the canonical A1.6 #3 vocabulary** — it is receipt-derived because claims here ARE replayable receipts (§6 check 1 needs `verify()` compatibility, which the exec-graph vocabulary cannot give). The exec-graph vocabulary stays exactly where it is, for graph evidence entries only; nothing migrates. `SPEC-PORTABLE-LESSONS-LEDGER.md` (D2) adopts THIS schema for its `EvidenceRef` at build time (see that spec's own reconciliation note) — one claim vocabulary for A1.6 #3 consumers, no third.

## 4. Evidence ledger

Directly extends ADR-0003 (`docs/adr/0003-append-only-ledger-plus-snapshot.md`). Two independent hash-chained JSONL logs under `state/evidence/` (default; `ATLAS_EVIDENCE_DIR` override, resolved by a `resolveEvidenceDir()` that is a straight rename of `exec-graph/ledger.ts:83-100`'s `resolveExecGraphDir()` — same cwd-then-module-walk-then-fallback logic, same landmark file `package.json`).

```
state/evidence/
  ledger.jsonl        # source of truth for claims — one EvidenceLedgerEntry per line
  snapshot.json        # derived, disposable: { claims: TypedClaim[], lastEntryHash: string|null, count: number }
  fp-registry.jsonl    # source of truth for penalties — one FpRegistryEntry per line, its OWN hash chain
  fp-snapshot.json      # derived, disposable, same shape idea
  audits/<auditRunId>/  # per-audit-run artifacts (§6), gitignored like state/swarm-runs/
    adversarial-log.jsonl
    summary.json
```

### 4.1 Hash chain

Generalizes both files with the same envelope, reusing `hands/contract.ts:134-157`'s `canonicalize()` + sha256 helper verbatim (import it, do not reimplement key-order-independent hashing a second time):

```typescript
export interface LedgerEntry<T> {
  entryId: string;   // uuid
  ts: string;         // ISO datetime
  actor: string;       // who/what appended this entry
  payload: T;           // TypedClaim for ledger.jsonl, FpPenaltyEntry for fp-registry.jsonl
  prevHash: string | null; // = previous entry's entryHash; null ONLY for entry index 0
  entryHash: string;        // sha256(canonicalize({entryId, ts, actor, payload, prevHash}))
}
```

`entryHash` is computed **after** `prevHash` is resolved, and is never recomputed retroactively for a prior entry — exactly ADR-0003's "never rewritten in place; the only write operation is `appendFileSync`" rule (`docs/adr/0003-append-only-ledger-plus-snapshot.md` lines 35-36), extended with a hash pointer instead of relying on file position alone.

**Tamper check** (`verifyChain(entries)`): for each entry `k`, two independent comparisons —
1. self-consistency: recompute `sha256(canonicalize({entryId,ts,actor,payload,prevHash}))` from entry `k`'s own stored fields and compare to its stored `entryHash`;
2. chain-linkage: compare entry `k`'s stored `prevHash` to entry `k-1`'s stored `entryHash`.

Either mismatch → `{ ok: false, failedAtIndex: k, reason: '...' }`. Flipping one byte anywhere in entry `k`'s `payload` fails check 1 **at `k`**, not downstream — this is the acceptance criterion in §7.6.

### 4.2 Writes

Follow `src/swarm-exec/run-bundle.ts:140-144`'s `writeAtomic()` pattern exactly (tmp file + `renameSync`) for `snapshot.json`/`fp-snapshot.json`; the JSONL append itself follows `exec-graph/ledger.ts:296-318`'s `persistEvent()` — loud-on-failure (`console.error`), never throws, snapshot write only attempted after a successful append. Reads never throw (`exec-graph/ledger.ts:196-232`'s `readLedgerEvents()` skip-and-log-malformed-line behavior, reused verbatim).

**Dedup / idempotency:** mirrors `exec-graph/ledger.ts:339-346`'s `task-created` special case — computing a content hash of `{claim, type, path, source, command, expectedSubstring}` (via the same `canonicalize()`+sha256 helper) and, if an entry with that hash already exists, appending nothing and returning `{deduped: true, claimId: <existing>}`.

### 4.3 Rotation

**None in scope**, matching ADR-0003's explicit accepted non-goal ("the ledger only grows... an accepted future concern, not solved here", `docs/adr/0003-append-only-ledger-plus-snapshot.md` lines 100-103, restated in `docs/state-and-evidence-index.md`'s retention rule). A future ADR would have to supersede ADR-0003's guarantees to add compaction here too — this spec does not attempt that.

## 5. False-positive penalty registry

```typescript
export const fpPenaltyIdSchema = z.string().regex(/^fpp_[a-z0-9][a-z0-9._-]{1,80}$/);

export const fpPenaltyEntrySchema = z.object({
  penaltyId: fpPenaltyIdSchema,
  ts: z.string().datetime(),
  actor: z.string().min(1),           // who/what recorded the refutation (usually 'auditor:<auditRunId>')
  refutedClaimId: claimIdSchema,       // the clm_... being penalized
  refutedSource: z.string().min(1),    // denormalized copy of the refuted claim's `source` — the FP-registry lookup key
  claimType: claimTypeSchema,           // denormalized `type` — penalties are scoped per (source, type), not globally per source
  penaltyWeight: z.number().min(0).max(1),
  reason: z.string().min(1),            // MUST cite counter-evidence — an auditor entryId, a human note with a receipt, etc.
  reversesPenaltyId: fpPenaltyIdSchema.optional(), // EXTENSION — explicit, append-only reversal of a prior penalty
});
export type FpPenaltyEntry = z.infer<typeof fpPenaltyEntrySchema>;
```

**Update rule.** A refutation (typically an `audit-finding` claim with `auditVerdict: 'stale'|'tampered'|'count-mismatch'`, or a human override) appends one `FpPenaltyEntry` to `fp-registry.jsonl`. The rule is deliberately **retroactive-at-read, never retroactive-at-write**: `TypedClaim.confidence` in `ledger.jsonl` is never mutated post-write (append-only invariant, §4). Every consumer (a future `cos brief`, wiki compile, recall ranking) must call:

```typescript
function computeEffectiveConfidence(claim: TypedClaim, fpEntries: FpPenaltyEntry[]): number {
  const active = fpEntries.filter(p =>
    p.refutedSource === claim.source && p.claimType === claim.type
    && !fpEntries.some(r => r.reversesPenaltyId === p.penaltyId));
  const totalPenalty = active.reduce((sum, p) => sum + p.penaltyWeight, 0);
  return Math.max(0, claim.confidence - totalPenalty);
}
```

never `claim.confidence` directly, for any downstream decision.

**Decay policy: none.** Same accepted non-goal as §4.3 — a penalty stays in force until an explicit `reversesPenaltyId` entry is appended; there is no time-based half-life. This avoids introducing a clock dependency into an otherwise pure/deterministic subsystem, matching the general "no LLM, no network, no ambient clock" posture this spec follows throughout. Flagged as a genuinely open call in §9.

**Explicit boundary:** this confidence math must **never** import or call anything from the ZenBrain/soul emotional-decay stack (`decayMultiplier`, PAD/Pulse). Per ADR-0009 Amendment A1.3: soul "NEVER touches facts, money, verification verdicts, or legal." Evidence confidence is a verification verdict; it stays purely deterministic.

## 6. Read-only auditor

### 6.1 Inputs

- `state/evidence/ledger.jsonl` + `fp-registry.jsonl` (read-only).
- The repo at a given ref (default: current working tree / `git rev-parse HEAD`).
- Optionally, `state/exec-graph/graph.json`/`ledger.jsonl` and `state/swarm-runs/*/bundle.json` as **audit targets** — read-only, via the exact same `readLedgerEvents()`/`readSnapshotFile()`/`readBundle()` functions those modules already export (`exec-graph/ledger.ts`, `swarm-exec/run-bundle.ts:219-230`), never a second parser.

### 6.2 Checks (all deterministic, no LLM, no network)

1. **Stale-receipt replay.** For every ledger claim whose `type` is one of the five receipt-derived kinds, reconstruct the equivalent `Receipt` shape (`path`→`ref`/`command`, `expectedSubstring`) and call `hands/verifier.ts`'s `verify()` again, now, against the live repo. If the claim's confidence implied "verified" (≥0.7, §3.2) but fresh `verify()` returns `{verified:false}`, append an `audit-finding` claim with `auditVerdict: 'stale'`, `sourceRef` = the original `claimId`, `confidence: 1.0`, `claim` = `verify()`'s new `reason` string. Agreements are **not** individually appended (ledger-bloat discipline) — only aggregated into the run's `summary.json` count.
2. **Hash-chain tamper check** (§4.1's `verifyChain()`) over both `ledger.jsonl` and `fp-registry.jsonl`. Any failure → `audit-finding` claim, `auditVerdict: 'tampered'`, `path` = `state/evidence/ledger.jsonl#entry<k>`, `confidence: 1.0`.
3. **Count-vs-content spot check** (canon §1: "verify content, not count"). For `command-output-match` claims whose `claim`/`expectedSubstring` text contains an explicit number (regex `/\b\d+\b/` — a new heuristic this spec introduces; **UNVERIFIED**: no existing module does this), re-run the SAME allowlisted command (`hands/verifier.ts:70-79`) and require the fresh output to contain that **exact number**, not merely the surrounding word. Mismatch → `auditVerdict: 'count-mismatch'`, both old and new numbers cited in `claim`.

### 6.3 Output

- `state/evidence/audits/<auditRunId>/adversarial-log.jsonl` — every finding this run produced, one per line (same envelope as `LedgerEntry<TypedClaim>`).
- `state/evidence/audits/<auditRunId>/summary.json` — written **last**, atomically (`writeAtomic()`, §4.2): `{ auditRunId, ref, startedAt, completedAt, checksRun: [...], confirmed, stale, tampered, countMismatch, proof: 'AUDIT-COMPLETE:<auditRunId>' }`. Mirrors `swarm-exec/run-bundle.ts:169-210`'s "sub-artifacts first, bundle last, proof token only on genuine completion" pattern exactly.
- Each finding is **also** appended to the shared `state/evidence/ledger.jsonl` as an `audit-finding` claim (§3), so findings participate in the same FP-registry/confidence machinery as any other claim, not a siloed report only.

### 6.4 Authority = NONE

The auditor module never imports `src/exec-graph/api.ts` or `src/exec-graph/verifier-port.ts`, and never calls `moveTask`/`reassignOwner`/`verifyAndTransition`/`moveTaskAsVerifier`/`reassignOwnerAsVerifier` by name — enforced by a structural test in the same style as `src/__tests__/hands.test.ts`'s source-regex assertions (`readFileSync` + regex over the module's own source, not just a code-review claim). This is the precedent `verifier-port.ts`'s own header comment states: *"IMPORT RESTRICTION: only `src/hands/exec-graph-adapter.ts` may import this module... Structural tests enforce this boundary."* The auditor is exactly the kind of caller that restriction exists to keep out.

### 6.5 Integration point

The auditor registers as a new `HandSpec` in `src/hands/registry.ts` — modeled directly on `local-readonly` (`src/hands/registry.ts:125-148`), the closest existing precedent (FREE, `trustLevel: 'low'`, `autonomy: 'read-only-unattended'`):

```typescript
'auditor-readonly': handSpecSchema.parse({
  handId: 'auditor-readonly',
  purpose: 'Free, read-only, unattended-capable auditor — replays stale receipts against ' +
    'current ground truth and checks the evidence-ledger hash chain for tampering. Writes ' +
    'ONLY append-only findings to state/evidence/; never touches state/exec-graph/ or ' +
    'state/swarm-runs/ directly; never calls moveTask/reassignOwner/verifyAndTransition.',
  capabilities: ['read-file', 'grep', 'git-readonly', 'command-readonly', 'evidence-append'],
  trustLevel: 'low',
  allowedEnvironments: ['local-foreground', 'local-unattended'],
  allowedActions: ['read-file', 'grep', 'git-readonly', 'command-readonly', 'evidence-append'],
  disallowedActions: ['write', 'deploy', 'mutation', 'credential-access', 'graph-write', 'verify-transition'],
  costClass: 'FREE',
  autonomy: 'read-only-unattended',
  inputContract: 'An audit request: ledger path + optional ref/since filter. No DelegationBrief objective ambiguity — the checks are fixed (§6.2).',
  timeoutMs: 120_000,   // same bound as local-readonly
  retryPolicy: 'none',
  abortPolicy: "On timeout, moves nothing (the auditor never owns a task's status) — the caller's own delegated task (if any) goes 'blocked' via the normal abortHandTask() path.",
  escalationCondition: 'A finding of type tampered on the evidence ledger itself -> escalate to ceo immediately (the check-on-Atlas layer is compromised), never silently retried.',
}),
```

**Schema-compatibility (verified 2026-07-23):** `allowedActions` is an open `z.array(z.string().min(1))` (`src/hands/contract.ts:40`), not a closed enum — `evidence-append` parses today with zero contract changes. The constraint is registry-doc convention, not schema.

**Note — this is the first `HandSpec` with a write-shaped `allowedActions` entry** (`evidence-append`). This does not violate ADR-0006's "Hands are descriptive-only" rule as applied to **exec-graph task state**; `state/evidence/` is a sibling non-authority store, precedented by `swarm-local`'s `state/swarm-runs/` writes (`src/hands/registry.ts`, ADR-0007). Flagged as open question 2 (§9) regardless, since it is a first-of-its-kind change to the registry's write posture.

If a task is explicitly delegated to run an audit, it closes through the **existing, unchanged** verifier: the executor writes `summary.json` with `AUDIT-COMPLETE:<auditRunId>`, builds a `file-contains` `Receipt` citing it, `submitReceipt` → `verifyAndTransition` (`hands/exec-graph-adapter.ts`) — identical to how `swarm-exec/executor.ts` closes a swarm task (ADR-0007). No new verifier logic is needed for this path.

## 7. Machine-checkable acceptance criteria for M8

1. `npm run typecheck && npm run build` exit 0.
2. `npm test` green, including new `src/__tests__/evidence-ledger.test.ts` and `src/__tests__/auditor.test.ts` (naming mirrors `src/__tests__/hands.test.ts`, `exec-graph.test.ts`).
3. Against a fixture ledger of 5 seeded claims (3 confirmable, 1 deliberately stale, 1 deliberately tampered), `node dist/cli.js evidence audit --ledger <fixture>` exits 0 and prints JSON whose `adversarialLogPath` resolves to a real file and `findingsCount >= 2` — this is the M8 DoD line "auditor's adversarial log attached."
4. `git status --porcelain state/` after step 3 (run against the real repo state dir, not the fixture) shows changes **only** under `state/evidence/` — no `state/exec-graph/` or `state/swarm-runs/` entries.
5. Structural test (mirrors `hands.test.ts` source-regex style): the auditor module's source does not match `/exec-graph\/api\.js/`, `/exec-graph\/verifier-port\.js/`, `/\bmoveTask\s*\(/`, `/\breassignOwner\s*\(/`, or `/\bverifyAndTransition\s*\(/`.
6. Tamper localization: flip one byte inside entry index 2's `payload.confidence` of a 5-entry fixture ledger (direct file write, bypassing the append API — simulating an attacker) → `verifyChain()` returns `{ ok:false, failedAtIndex: 2 }`, not any other index.
7. FP-registry downweight: seed claim A (`source:'hand:sonnet-foreground'`, `confidence:0.7`); append an fp-registry entry refuting it (`penaltyWeight:0.5`); seed claim B, same source+type, same raw `confidence:0.7` → `computeEffectiveConfidence(claimB, fpSnapshot) === 0.2`, while `claimB.confidence` (raw stored value) stays `0.7`.
8. Dedup: appending a key-reordered but content-identical claim twice yields exactly one new ledger entry; the second call returns `{ deduped: true }` (mirrors `exec-graph/ledger.ts`'s `AppendResult` shape).
9. `git log -p state/evidence/ledger.jsonl` after a full test run shows every entry as an individually diffable added line — no existing line is ever modified across the run (ADR-0003's audit-trail guarantee, restated for this ledger).

## 8. Negative tests

- **Forged confidence.** A claim with `type:'narrative'` and `confidence:1.0` is rejected at schema validation (§3.2's `superRefine`), before it ever reaches the ledger — mirrors `hands/contract.ts:81-127`'s `receiptSchema.superRefine` field-presence pattern, extended to a cross-field confidence/type invariant.
- **Replayed receipt (two distinct meanings, both tested).** (a) Content-identical resubmission dedupes to one entry, no double-count (§7.8). (b) A **replayed-but-stale** receipt — same `command`/`expectedSubstring` content as a prior claim, but the underlying artifact has since changed — is caught by check 1 (§6.2) regardless of the dedup key, because staleness detection always re-runs `verify()` against **current** state, never trusts the historical match. A test must seed exactly this case: submit claim, mutate the target file, run the auditor, assert an `audit-finding`/`stale` claim is produced even though no new claim was submitted.
- **Auditor attempting a graph write.** Structurally impossible per §6.4/§7.5 — a test that monkey-patches or spies on `exec-graph/api.ts`'s exports and asserts zero calls during a full auditor run, plus the static source-grep test, both must pass (belt + suspenders).
- **Duplicate claim dedup** — covered by §7.8.

## 9. Open questions for codex-verifier

1. **"Outside the hierarchy" vs. "registers as a Hand."** ADR-0009 A1.6 #4 calls for a whistleblower agent "outside the hierarchy — the check on Atlas itself." This spec registers it as an ordinary `HandSpec` (§6.5), subject to the same `hands/registry.ts` that a compromised or careless Atlas instance could edit. Does a normal Hand-registry entry satisfy A1.6 #4's intent, or does "outside the hierarchy" require a structurally separate invocation path (e.g. a fixed script the registry itself cannot gate, or a CI-triggered run) that M8 should build instead?
2. **First write-shaped `allowedActions` verb.** `evidence-append` (§6.5) is the first HandSpec write capability in a registry that has so far enumerated a closed, all-read set with an explicit rationale per hand. Does adding this need the same kind of adversarial-review pass ADR-0006's own Context section describes for the original Hand Contract cut, before M8 merges it?
3. **FP-registry decay (§5).** This spec defines no time-decay — a penalty is permanent until explicitly reversed, matching ADR-0003's "ledger only grows" non-goal. Is that the right default given a fast-changing swarm-worker/hand roster, or should M8 add a bounded decay window even though that introduces a clock dependency this otherwise-deterministic subsystem currently avoids entirely?
