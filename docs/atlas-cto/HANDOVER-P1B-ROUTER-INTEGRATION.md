# HANDOVER — P1-B: Wire Durable Spend Authority Into the Production Router

> Mission brief for a terminal Atlas session (`claude -p`, no chat scrollback, no memory
> of prior sessions). Written 2026-08-06 by a research-only worker (no code changes, no
> merge, no push performed while producing this brief). Every claim below is tagged
> **FACT** (read directly from the repo, file:line given) or **INFERENCE** (reasoned from
> facts, not directly read). Anything not read is tagged **UNKNOWN** with the exact file
> to open.

---

## 1. Mission in one paragraph

Make the durable spend authority (`src/atlas/spend/*`, P1-B waves 1–2 + the 2026-08-06
provider-invocation-idempotency repair) **unavoidable on the real provider call path**.
Today it is fully built, fully tested in isolation, and has **zero production callers**
(FACT — see §4, §5, §12 of `docs/atlas-cto/CURSOR-HANDOFF.md` read at worktree commit
`1b0bb77`). When this mission is done, a paid provider must be **uncallable** anywhere
in this repo without: (1) Work Order authority, (2) a durable reservation against
today's cap, (3) a durable invocation claim (at most one real network call per
`requestId`, ever), (4) `requestId` idempotency across retries/restarts/concurrent
callers, and (5) a committed-or-reconciled receipt. No new ledger, no new cap
authority, no second cost router — reuse what already exists (§3).

---

## 2. Start state — STOP RULE FIRST

**Before doing anything else, re-run these exact commands and compare against the
values below. If the tree is dirty, or HEAD differs from what is stated here, STOP and
report — do not proceed, do not "fix" the mismatch yourself.**

```
git -C "C:/Users/user/OneDrive/Documents/GitHub/ANUS" log --oneline -3
git -C "C:/Users/user/OneDrive/Documents/GitHub/ANUS" branch --show-current
git -C "C:/Users/user/OneDrive/Documents/GitHub/ANUS" status --porcelain
git -C "C:/Users/user/OneDrive/Documents/GitHub/ANUS/.worktrees/p1b-spend-cap" log --oneline -3
git -C "C:/Users/user/OneDrive/Documents/GitHub/ANUS/.worktrees/p1b-spend-cap" branch --show-current
git -C "C:/Users/user/OneDrive/Documents/GitHub/ANUS/.worktrees/p1b-spend-cap" status --porcelain
```

Observed 2026-08-06 (FACT):

| Checkout | Branch | HEAD | Status |
|---|---|---|---|
| Canonical `ANUS` | `codex/atlas-cost-router-design` | `c92a570` merge: P1-A signed work orders + RepoWriterLease single-writer authority | clean (`git status --porcelain` empty) |
| Worktree `.worktrees/p1b-spend-cap` | `codex/p1b-spend-cap` | `1b0bb77` chore: cursor handoff | clean (`git status --porcelain` empty) |

The 5 approved commits, verified as a **linear chain descending directly from the
canonical HEAD** (`git log --oneline -10` in the worktree, FACT):

```
1b0bb77 chore: cursor handoff
0d2a618 fix(spend): durable provider-invocation claim — one requestId, at most one invocation
6f07a5d chore: cursor handoff
671a6cb feat(spend): bounded CEO override, tamper rejection, lease-to-mutation binding (P1-DEBT-01)
a059a45 feat(spend): restart-durable atomic spend ledger with idempotent reservations
c92a570 merge: P1-A signed work orders + RepoWriterLease single-writer authority   <- canonical HEAD, matches
```

Work happens **only** in the `.worktrees/p1b-spend-cap` worktree (isolated from canonical
checkout — see §11). The `src/atlas/spend/` directory exists **only** in this worktree
today (FACT — `src/atlas/spend/` is absent from the canonical checkout's `src/atlas/`,
confirmed by directory listing; canonical `src/atlas/` has no `spend/` subdirectory,
only the legacy `spend-policy.ts` / `spend-tracker.ts` files described in §4).

---

## 3. What already exists and MUST be reused

**Do NOT create a second cost router, second ledger, second budget authority, or
provider-specific shadow counters.** Everything below already exists, is tested, and is
the only sanctioned surface.

### 3a. Spend module public API — `src/atlas/spend/index.ts` (FACT, full file read)

Re-exported from `types.js`, `accounting-day.js`, `store.js`, `ledger.js`,
`preflight.js`, `override.js`. The caller-facing entrypoint is `runSpendPreflight`
(from `preflight.js`); everything else is either a type or a lower-level primitive
`preflight.ts` already composes correctly — do not call `ledger.ts` functions directly
from a new call site, go through `runSpendPreflight`.

`src/atlas/spend/preflight.ts` (FACT, full file read, `.worktrees/p1b-spend-cap/src/atlas/spend/preflight.ts`):

```ts
// preflight.ts:57
export type ProviderPort = () => Promise<ProviderInvocationOutcome>;

// preflight.ts:51-55
export interface ProviderInvocationOutcome {
  result: unknown;
  actualCostMinor: number;   // integer minor units, as reported by the provider adapter
}

// preflight.ts:59-75
export interface SpendPreflightInput {
  signedWorkOrder: SignedWorkOrder;
  scopeContext: Omit<WorkOrderScopeCheckContext, 'commandClass'>;
  requestId: string;
  projectOrMissionId: string;
  provider: string;
  model: string;
  currency: string;
  estimatedCostMinor: number;   // integer, caller-computed — NO price table inside this module (see §6)
  dailyCapMinor: number;
  now: Date;
  ianaTimezone: string;
  sourceReceiptHash: string;
  invokeProvider: ProviderPort;   // injected — this module never makes a real network call itself
  rootDir?: string;
}

// preflight.ts:77-91
export type SpendPreflightVerdict =
  | { ok: true; result: unknown; record: SpendRecord; idempotentReplay: boolean }
  | { ok: false; reason: 'work_order_scope_denied'; workOrderReason: WorkOrderValidationFailureReason }
  | { ok: false; reason: 'cap_exceeded'; record: SpendRecord }
  | { ok: false; reason: 'state_unavailable'; detail: string }
  | { ok: false; reason: 'invocation_in_progress'; record: SpendRecord }
  | { ok: false; reason: 'pending_reconciliation'; record: SpendRecord }
  | { ok: false; reason: 'terminal_request_id'; record: SpendRecord }
  | { ok: false; reason: 'integrity_violation'; record: SpendRecord }
  | { ok: false; reason: 'provider_invocation_failed'; error: unknown; record: SpendRecord };

// preflight.ts:103
export async function runSpendPreflight(input: SpendPreflightInput): Promise<SpendPreflightVerdict>
```

**Internal sequencing a caller must respect (FACT, preflight.ts:104-214):**
1. `checkWorkOrderScope(signedWorkOrder, { ...scopeContext, commandClass: provider })` —
   provider name is checked against the Work Order's `allowedCommandClasses`; there is
   no dedicated provider field on `WorkOrder`, `commandClass` is deliberately reused
   (preflight.ts:30-33 comment).
2. `reserve(reserveInput)` from `ledger.ts` — atomic, idempotent reservation against
   `dailyCapMinor`.
3. `claimProviderInvocation(...)` from `ledger.ts` — the **sole authority** for whether
   `invokeProvider()` may run. `reserveResult.idempotent` is explicitly NEVER used as
   permission (preflight.ts:141-146 comment — this was the exact bug the 2026-08-06
   repair fixed).
4. Only on `claimResult.outcome === 'claimed'` is `input.invokeProvider()` called — at
   most once per `requestId`, ever, across retries/restarts/concurrent callers
   (preflight.ts:93-101 doc comment).
5. `commit(...)` on success; `markPendingReconciliation(...)` if `invokeProvider()`
   throws (ambiguous outcome — never silently released, never silently erased).

### 3b. Work Order primitives (names + line FACT via grep; full param shapes UNKNOWN — open the files)

- `checkWorkOrderScope` — `src/atlas/work-order/validate.ts:134`. Usage pattern
  confirmed at preflight.ts:104-110 (returns `{ ok: boolean; reason?: ... }`-shaped
  verdict). Full declared signature: UNKNOWN, open `validate.ts:134`.
- `claimWorkOrder` — `src/atlas/work-order/validate.ts:191`. Not used by
  `preflight.ts` (preflight.ts:23-26 comment explains why: a single Work Order
  authorizes many provider calls, so one-shot nonce consumption is a separate step
  owned by whoever claimed the task). Full signature: UNKNOWN, open `validate.ts:191`.
- `runExecutorGateMutation` — `src/atlas/work-order/executor-gate.ts:286`. Full
  signature: UNKNOWN, open `executor-gate.ts:286`.
- `RepoWriterLease` — `src/atlas/work-order/repo-writer-lock.ts`: exported functions
  `acquireRepoWriterLease` (214), `heartbeatRepoWriterLease` (272),
  `releaseRepoWriterLease` (311), `recoverStaleRepoWriterLease` (368),
  `getRepoWriterLeaseInfo` (417). Full signatures: UNKNOWN, open
  `repo-writer-lock.ts` at those lines.

### 3c. State-root convention (FACT)

`resolveMigratingStateDir(store: StateStore, legacyDefault: () => string, legacyEnv?: string | null): string`
— `src/atlas/state-root.ts:425-430`. `spend-tracker.ts` (legacy) and the new
`spend/store.ts` both route through this convention for where durable state lives.
Any new integration point that needs a directory must use this, not a hardcoded path.

### 3d. Evidence ledger (FACT — files present, not read in full)

`src/evidence/auditor.ts`, `src/evidence/claim.ts`, `src/evidence/ledger.ts` exist.
UNKNOWN whether/how the spend module's evidence packs (see §8) already integrate with
this — open these three files before assuming a shape.

### 3e. Explicit prohibition

Do not: build a second `runSpendPreflight`-equivalent; add a parallel in-memory
"already called" `Set`/counter (the 2026-08-06 repair's own test suite,
`src/__tests__/spend-provider-idempotency.test.ts`, has source-scan tests that fail the
build if one appears in `ledger.ts`/`preflight.ts` — the same discipline applies to
wherever you add the router integration); add a provider-specific spend tracker.

---

## 4. Current call graph as observed (FACT unless marked)

**Entrypoint → router → adapter, today, has NO gate in the middle for most call
sites.** Two parallel spend-tracking systems exist and neither is `atlas/spend/*`:

- **Legacy, coarse, wired-but-weak**: `src/atlas/spend-policy.ts` `enforceSpendPolicy(provider, caller)`
  (spend-policy.ts:111-128) — throws only on `paid && !ATLAS_ALLOW_PAID` or
  `paid && overDailyCap()`. It is a **boolean gate, not a reservation** — no atomicity,
  no per-call cap deduction, no idempotency. `overDailyCap()` reads an **in-memory**
  daily token counter (`spend-tracker.ts` `getDailyTokenTotal()`) that is rehydrated
  from local JSONL receipts but is **not** the durable, lock-protected day-file ledger
  in `atlas/spend/`.
- **New, correct, unwired**: `atlas/spend/preflight.ts` `runSpendPreflight(...)` — has
  **zero real callers anywhere in `src/` outside its own test file** (FACT — confirmed
  by the CURSOR-HANDOFF.md §4/§6 statement "the cap/claim machinery remains fully built
  and tested in isolation, not yet load-bearing", read at worktree commit `1b0bb77`).

### The TOCTOU gap — `src/atlas/mastra-agent.ts` (FACT, exact lines)

```ts
// mastra-agent.ts:14-16 (imports)
import { routeModel, type ModelRole, type RouteResult } from '../model-router.js';
import { recordSpendFromResult } from './spend-tracker.js';
import { enforceSpendPolicy } from './spend-policy.js';

// mastra-agent.ts:50-51  — inside getAgent()
const route = routeModel({ role });
enforceSpendPolicy(route.provider, 'api');
_lastRoute = route;
// ... agent constructed at line 54, model = route.model — no gate between here and the real call.

// mastra-agent.ts:89-90 — inside the caller, AFTER the real network call already happened
const result = await agent.generate(prompt);
if (_lastRoute) recordSpendFromResult(result, { provider: _lastRoute.provider, model: _lastRoute.modelId, caller: 'api' });

// mastra-agent.ts:171-172 — a second call site, same pattern
const result = await agent.generate(prompt);
if (_lastRoute) recordSpendFromResult(result, { provider: _lastRoute.provider, model: _lastRoute.modelId, caller: 'api' });
```

The gap: `enforceSpendPolicy` is a **pre-call boolean check** against a **non-atomic,
in-memory-then-rehydrated** counter, called **once** when `getAgent()` builds the agent
— not once per `agent.generate()` call, and with no reservation held between the check
and the real call. `recordSpendFromResult` records spend **only after** the real
provider call already completed — this is a pure telemetry write, not a gate. Two
concurrent callers (or a cached `_lastRoute` reused across multiple `generate()` calls
without re-checking) can both pass `enforceSpendPolicy` before either one's spend is
recorded. This is exactly the class of bug `atlas/spend/ledger.ts`'s
`claimProviderInvocation()` compare-and-set was built to close (§3a) — it is simply not
called from here.

**What the terminal session must still trace itself (mark as it goes):** every other
call site that reaches `routeModel`/`routeModelWithFallback` in `src/` (grep
`routeModel(` and `routeModelWithFallback(` across `src/` — this brief covers
`mastra-agent.ts` and the 4 named bypasses in §5 as confirmed spot checks, not an
exhaustive list of every call site in the repo).

---

## 5. The four known bypasses (FACT, exact lines — cross-confirmed against
`docs/atlas-cto/MISSION-BOARD.md:53`, `P1-DEBT-02` row, same four file:lines)

**Rule: any active paid bypass blocks P1-B completion. If it cannot be safely migrated
to `runSpendPreflight` in this wave, disable it fail-closed (throw / refuse) and record
it as a new debt row — never leave it silently active on a paid path.**

1. **`src/atlas/telegram-capability.ts:89`** — direct, ungated, unrouted call to a paid
   provider. Not even in `model-router.ts`'s registry.
   ```ts
   // line 89
   const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
   ```
   No `routeModel`, no `enforceSpendPolicy`, no `runSpendPreflight` anywhere in this
   function. Comment at line 3 confirms intent: `"Local-first for sensitive audio;
   OpenAI Whisper remains cloud fallback."` — the fallback path is completely ungated.
   **Highest-priority bypass — real money, zero gate of any kind.**

2. **`src/tools/surf.ts:227`** — routes through `routeModelWithFallback` but with no
   spend gate before or after:
   ```ts
   // line 227-228
   const { result, route } = await routeModelWithFallback(
     { role: 'WORKER', excludeProviders: ['anthropic'] },
   ```
   `maxCostTier` is **not set** here, so it defaults to `3` (model-router.ts:270,320)
   — `openai` (costTier 1) and `openrouter` (costTier 1) remain selectable candidates.
   Only `anthropic` is excluded. **This is a live paid-provider path today** whenever
   `OPENAI_API_KEY` or `OPENROUTER_API_KEY` is set and free providers are unavailable.

3. **`src/atlas/emotion.ts:243`** — same pattern, no exclusions at all:
   ```ts
   // line 243
   const { result } = await routeModelWithFallback({ role: 'FAST' }, async (route) => {
   ```
   No `excludeProviders`, no `maxCostTier`. `openai`, `openrouter`, **and** `anthropic`
   (all `FAST`/`JUDGE`-role-eligible paid tiers) remain selectable. **Live paid-provider
   path, wider exposure than `surf.ts` (includes Anthropic).**

4. **`src/goal-runner/red-line.ts:292`** — routes through `routeModelWithFallback` with
   `maxCostTier: 0`:
   ```ts
   // line 292-293
   const { result } = await routeModelWithFallback(
     { role: 'FAST', maxCostTier: 0, excludeProviders: ['anthropic'] },
   ```
   INFERENCE: `maxCostTier: 0` currently excludes every provider whose `costTier` in
   `MODEL_REGISTRY` (model-router.ts:47-111) is above 0 — today that means `openai`
   (tier 1), `openrouter` (tier 1), and `anthropic` (tier 2) are all structurally
   unreachable here, **as long as the registry's cost tiers don't change**. This bypass
   is therefore lower risk *today* than #2/#3, but it still routes around
   `runSpendPreflight` entirely — nothing prevents a future registry edit (e.g. a new
   costTier-0 paid provider, or someone bumping `maxCostTier`) from silently reopening
   it. Treat it as a structural bypass that needs the same enforcement boundary as the
   other three, not as "already safe, skip it."

All four are also independently listed at `docs/atlas-cto/MISSION-BOARD.md:53`
(`P1-DEBT-02`, status `OPEN — out of allowed scope this wave` as of worktree commit
`1b0bb77`) — this brief's four file:lines match that row exactly; treat any drift
between this brief and a re-grep as the re-grep being authoritative (code may have
moved since 2026-08-06).

---

## 6. Required design

**Single narrowest enforcement boundary.** One function, one place, that every real
provider call in `src/` must pass through before the network call happens. The
strongest candidate location (INFERENCE — the terminal session should confirm before
committing to it) is inside `routeModelWithFallback`'s `callFn` invocation in
`src/model-router.ts` (around line 355, `const result = await callFn(route);`) or a
thin wrapper around `createModel()` — NOT a re-implementation inside each of the 5+ call
sites individually. Whichever boundary is chosen, `routeModel()` (the non-fallback,
non-invoking variant that only *selects* a config, model-router.ts:266-306) stays a
pure selector — the gate belongs at the point where a model is actually about to be
invoked, not at selection time (this is precisely the bug in §4: `mastra-agent.ts`
gates at selection time, not call time).

**Invariant:** no durable invocation claim (`claimProviderInvocation` returning
`outcome: 'claimed'`, or an idempotent `outcome: 'replay'`) → the provider function
(`createModel(...)`'s returned model, or whatever ultimately does `fetch`) **cannot be
called**. This must be true even under: process crash between claim and invoke (already
proven — the 2026-08-06 live-proof test, §5 of CURSOR-HANDOFF.md), concurrent duplicate
callers, retried requests with the same `requestId`, and process restart.

**Provider classification — three buckets, computed BEFORE any network call:**
- `FREE_RECORDED` — `costTier === 0` in `MODEL_REGISTRY` today (`ollama`, `freellmapi`,
  `gemini`, `groq`, `nvidia`, `azure` — FACT, model-router.ts:47-111). Still goes
  through `runSpendPreflight` for a durable receipt (idempotency + evidence), but
  `estimatedCostMinor` is `0` and no cap check blocks it.
- `PAID_CAP_REQUIRED` — `openai`, `openrouter`, `anthropic` today (costTier 1/2). MUST
  have a deterministic, non-zero `estimatedCostMinor` computed from a real price table
  before `runSpendPreflight` is called.
- `DISABLED_UNCLASSIFIED` — any provider not in a maintained price table, or any new
  provider added to `MODEL_REGISTRY` without a corresponding price-table entry. Rejects
  **before** any network call — same as an unknown price (see below).

**No price table currently exists that is fit for this purpose (FACT).** The only price
table in the repo is `src/atlas/spend-tracker.ts:52-62`:
```ts
const PRICE_PER_MILLION: Record<string, { in: number; out: number }> = {
  ollama: { in: 0, out: 0 }, freellmapi: { in: 0, out: 0 }, groq: { in: 0, out: 0 }, nvidia: { in: 0, out: 0 },
  openai: { in: 0.15, out: 0.6 }, openrouter: { in: 0.3, out: 0.5 }, anthropic: { in: 3, out: 15 },
};
```
This is **floating-point USD per million tokens**, covers only 7 of the 9
`model-router.ts` providers (**missing `azure` and `gemini` entirely** — FACT, cross-
checked against `MODEL_REGISTRY`), and is consumed by the legacy, non-atomic
`estimateCostUsd()` — it is architecturally incompatible with `atlas/spend/types.ts`'s
integer-minor-units contract (types.ts:5, FACT: `"No field here is ever a float dollar
amount"`). **Do not reuse `PRICE_PER_MILLION` as-is.** Build (or explicitly port with
integer conversion + the two missing providers filled in) a new integer-minor-unit
price table that classifies every `ProviderName` in `model-router.ts` into one of the
three buckets above, with unknown-price and unknown-provider both rejecting.

**Forbidden, explicitly:**
- Zero-cost default on an unknown/missing price (must reject, not silently charge $0).
- A caller-supplied "this is free" flag (`estimatedCostMinor` must be computed from the
  classification/price table, never trusted from the call site).
- Post-call-only checks (the existing `recordSpendFromResult` pattern, §4 — recording
  after the fact is telemetry, not a gate, and must not be the only enforcement).
- Floating-point money anywhere in the new boundary — integer minor units only, matching
  `atlas/spend/types.ts`'s existing contract.

---

## 7. The 18 required integration tests (acceptance criteria — falsifiable, run
against the REAL router entrypoint with injected fake providers, never a standalone
proof script)

Each test below must fail if the described behavior is absent, and must exercise
`model-router.ts`'s actual exported functions (`routeModel`, `routeModelWithFallback`,
or whatever new wrapper becomes the enforcement boundary) with a fake `ProviderPort`
injected — not a hand-rolled simulation of the router's logic.

1. A `PAID_CAP_REQUIRED` provider call with `estimatedCostMinor` under the remaining
   daily cap succeeds, and the injected fake provider's call counter reads exactly `1`.
2. The same `requestId` replayed in-process (same call repeated) does not increment the
   fake provider's call counter beyond `1`; the second call returns the stored
   `committedResult`.
3. The same `requestId` replayed after a simulated process restart (fresh module
   state, same on-disk ledger dir) still does not increment the fake provider's call
   counter beyond `1`.
4. A request whose `estimatedCostMinor` exceeds the remaining daily cap is rejected
   (`reason: 'cap_exceeded'`) and the fake provider's call counter stays at `0`.
5. A provider with no entry in the price/classification table (`DISABLED_UNCLASSIFIED`)
   is rejected **before** the fake provider function is invoked — call counter `0`.
6. A `FREE_RECORDED` provider call succeeds with a `0`-minor-unit receipt, and the fake
   provider's call counter is at most `1` (never invoked twice for one logical call).
7. After a successful claim (`outcome: 'claimed'`) but before `commit`, if the router's
   fallback logic decides to try a second, different paid provider (provider
   uncertainty / adapter throwing), the second paid provider's fake port must NOT be
   invoked — fallback across paid providers without an intervening resolved
   claim/release is refused.
8. A record left in `PENDING_RECONCILIATION` (simulated crash mid-invocation) continues
   to count against the daily cap for a subsequent, different `requestId`'s cap check —
   the cap is not silently freed by an unresolved record.
9. A record in `INVOCATION_STARTED` (claimed, not yet committed) causes a concurrent
   second caller with the **same** `requestId` to be refused
   (`reason: 'invocation_in_progress'`) with the fake provider invoked at most once
   total across both callers.
10. A terminal record (`RELEASED` or `REJECTED`) refuses reuse of the same `requestId`
    (`reason: 'terminal_request_id'`) even when resubmitted with a fresh
    `estimatedCostMinor`/cap.
11. A Work Order that does not authorize the requested provider (via
    `checkWorkOrderScope`'s `commandClass` check) is rejected
    (`reason: 'work_order_scope_denied'`) before any reservation or invocation attempt
    — fake provider call counter `0`.
12. An expired, malformed, or unsigned Work Order is rejected by the same boundary —
    fake provider call counter `0`.
13. Each of the four bypass call sites named in §5 (`telegram-capability.ts`,
    `surf.ts`, `emotion.ts`, `red-line.ts`) — after remediation — is proven, via a
    source-scan or integration test against the actual file, to route through the new
    enforcement boundary (or to be explicitly fail-closed-disabled with a debt row, per
    the §5 rule). One test per site, four total.
14. `mastra-agent.ts`'s `getAgent()`/`generate()` path (§4) is proven, via an
    integration test that calls the real exported function with a fake provider
    injected underneath, to gate at call time (not just at agent-construction time) —
    i.e. calling `generate()` twice on a cached `_lastRoute` re-checks/re-reserves each
    time, not just once at `getAgent()`.
15. A source-scan test (matching the style of `spend-provider-idempotency.test.ts`'s
    existing scans) asserts no new in-memory `Set`/counter/`.has(requestId)` membership
    check was introduced anywhere in the new router-integration code as a substitute
    for the durable claim.
16. A source-scan or static test asserts the new price/classification table has an
    entry for every `ProviderName` currently in `model-router.ts`'s `MODEL_REGISTRY`
    (fails loudly if a provider is added to the registry without a corresponding
    price-table entry — closes the `azure`/`gemini` gap named in §6 and prevents
    regression).
17. A test asserts every `estimatedCostMinor` value produced by the new price
    table/classifier is a non-negative integer (`Number.isInteger`) — no floats reach
    `runSpendPreflight`.
18. A full-suite regression check: the existing 60 spend tests
    (`spend-durable.test.ts`, `spend-override-and-proof.test.ts`,
    `spend-provider-idempotency.test.ts`) still pass unmodified after the router
    integration lands — the integration must be purely additive at the call-site level,
    never a change to `ledger.ts`'s state machine.

---

## 8. Live bounded proof — 13-step scenario

Run against the real integration (real `model-router.ts` entrypoint + real
`runSpendPreflight`), with **fake providers only, no network, no credentials**. Evidence
pack under `$HOME/.atlas/quarantine/evidence/p1b-router-<timestamp>/` (same convention
as the existing P1-B live-proof packs — see CURSOR-HANDOFF.md §3 for the sibling
`p1b-idem-<timestamp>` convention already in use; do not invent a new directory shape).

1. Paid provider call under cap → succeeds.
2. Fake provider's invocation count reads `1`.
3. Replay the identical call in the same process (same `requestId`) → succeeds,
   returns the stored result.
4. Invocation count still `1` after step 3.
5. Replay after a simulated restart (fresh process/module state, same on-disk ledger
   dir) → succeeds, returns the stored result.
6. Invocation count still `1` after step 5.
7. A new request over the remaining daily cap → rejected (`cap_exceeded`).
8. Invocation count unchanged after step 7.
9. A request for an unknown/unclassified provider → rejected before any call.
10. Invocation count unchanged after step 9 (no invocation at all for the unknown
    provider).
11. A free provider call → succeeds with a zero-cost receipt, at most one invocation of
    the free provider's fake port.
12. Simulate provider uncertainty after a successful claim (adapter throws) → the
    router's fallback logic must NOT invoke a second, different paid provider without
    an intervening resolved claim.
13. The resulting `PENDING_RECONCILIATION` record still holds (counts against) the
    daily cap — confirmed by a follow-up cap check.

Write each step's observed result into the evidence pack (claim kinds, matching the
existing convention of named claim kinds in the 2026-08-06 live proof — see
CURSOR-HANDOFF.md §3 for the 9-kind example from the sibling proof).

---

## 9. Bypass audit procedure

Run these from the worktree root (`.worktrees/p1b-spend-cap`) after the integration
lands, and classify every hit as one of: **protected** (goes through the new
boundary) / **test-only** (only reachable from `src/__tests__/`) / **dead** (unreachable
code) / **disabled** (fail-closed per §5's rule) / **active-bypass** (still live and
ungated — this is a P1-B blocker if any remain, per §5).

```
# Direct SDK / raw network calls to model endpoints, outside model-router.ts
rg -n "fetch\(.*api\.(openai|anthropic|groq|nvidia|googleapis)\.com" src/ --glob '!src/model-router.ts'
rg -n "createOpenAI\(|createAnthropic\(|createOpenAICompatible\(" src/ --glob '!src/model-router.ts'

# All routeModel / routeModelWithFallback call sites (re-derive the full list — §4 only names spot-checked sites)
rg -n "routeModel\(|routeModelWithFallback\(" src/

# Fallback happening outside the router (a second createModel/adapter call not inside model-router.ts)
rg -n "createModel\(" src/ --glob '!src/model-router.ts'

# Env / debug spend bypasses
rg -n "ATLAS_ALLOW_PAID|ATLAS_SKIP_SPEND|SPEND_BYPASS|DEBUG.*spend" -i src/

# Confirm the 4 named bypasses' current line numbers (code may have moved since 2026-08-06)
rg -n "api.openai.com/v1/audio" src/atlas/telegram-capability.ts
rg -n "routeModelWithFallback" src/tools/surf.ts src/atlas/emotion.ts src/goal-runner/red-line.ts
```

---

## 10. Verification contract

**Host quirks (FACT, confirmed in CURSOR-HANDOFF.md §3, read at worktree commit
`1b0bb77`):** `npx` is broken on this host (`node_modules/.bin` missing) — do not use
`npx vitest` or `npx tsc`. Use:

```
node node_modules/vitest/vitest.mjs run [files...]     # test runner
node node_modules/typescript/bin/tsc --noEmit           # typecheck
```

**Focused run, TWICE**, on whatever new test files this mission adds plus the existing
spend suite:
```
node node_modules/vitest/vitest.mjs run src/atlas/spend/... <new integration tests> src/__tests__/spend-durable.test.ts src/__tests__/spend-override-and-proof.test.ts src/__tests__/spend-provider-idempotency.test.ts
```
Report both runs' exact `Test Files` / `Tests` / `exit` lines. Two identical passing
runs are the acceptance bar for the focused set (matches the existing project
convention — CURSOR-HANDOFF.md §3 ran the prior wave's focused set twice with 60/60
passed both times).

**Full suite, ONCE.** Current baseline at worktree HEAD `1b0bb77` (FACT, read from
CURSOR-HANDOFF.md §3):
```
node node_modules/vitest/vitest.mjs run
Test Files  2 failed | 156 passed (158)
     Tests  3 failed | 1589 passed | 12 skipped (1604)
exit 1
```
The 3 pre-existing failures are all in `m10-install-lifecycle.test.ts` (install/
upgrade/rollback ×1 each) — caused by the host's broken `npx tsup` resolution inside
vitest's child-process context, **not** a code defect. **The suite is never called
"green" while exit is 1.** Report the new run's numbers as a delta against this exact
baseline (`+N passed` for new tests, `0 new failures`, same 3 pre-existing failures,
same 12 skipped) — do not claim "all green," claim the verified delta.

**Typecheck baseline** (FACT, read from CURSOR-HANDOFF.md §3), 3 pre-existing errors,
same two files, unrelated to spend/router code:
```
src/__tests__/runner-health-no-claim.test.ts(390,13): error TS2352
src/__tests__/runner-health-no-claim.test.ts(396,77): error TS2352
src/courier/courier-loop.ts(549,23): error TS2367
exit code: 2
```
Report the new typecheck run's error count and confirm none of your changed files
appear in the output (count must stay 3, same two files, unless you deliberately touch
`runner-health-no-claim.test.ts` or `courier-loop.ts`, which this mission has no reason
to do).

---

## 11. Working rules for the terminal session

- One bounded executor at a time. Isolated worktree (`.worktrees/p1b-spend-cap` —
  already exists, already on the correct branch; do not create a second worktree
  without checking this one first).
- Max one repair cycle per item, then STOP and report BLOCKED — do not loop on the same
  failure a third time (per the reliable-execution "3 tries then switch layer" rule).
- No push, no merge — the orchestrator merges after independent verification.
- No pause/PANIC, no Integronix, no Planning, no scheduler, no browser — none of those
  systems are in scope for this mission.
- Never claim "done" without a same-turn tool receipt (Read/Bash/test output) — this is
  a hard project rule, not a style preference.
- 60/30/10 model discipline: mechanical edits, greps, scans, and test runs go to
  Haiku/Sonnet-tier execution; Opus/Fable-tier reasoning is reserved for the actual
  design decision in §6 (where the enforcement boundary sits) and for verifying the
  live proof in §8.

---

## 12. Handoff obligation

Before stopping, update `docs/atlas-cto/CURSOR-HANDOFF.md` in the worktree
(`.worktrees/p1b-spend-cap`) with the standing six sections (mirror the structure
already in the file as of commit `1b0bb77`: **1.** Date/branch/HEAD, **2.** Files
changed (one line each), **3.** Receipts (exact commands, output, exit codes — focused
×2, full suite ×1, typecheck), **4.** Known risks/broken items, **5.** Next three
steps, **6.** Blockers for CEO/orchestrator), then commit it in that same worktree.
Then **STOP** — do not push, do not merge, wait for orchestrator verification.

---

## 13. Final report template

Return exactly these items, each with a receipt:

- Integration commit SHA (worktree, not canonical).
- Changed files, one line each (mirror CURSOR-HANDOFF.md §2 style).
- The real call graph as traced (which entrypoints now route through the new boundary,
  file:line for each).
- The chosen enforcement boundary (file:line, and why — reference §6).
- Bypass audit results (§9's four-way classification, all four named bypasses from §5
  plus any new ones the re-grep surfaced).
- Disabled paths, if any (fail-closed per §5, with the debt row filed).
- Provider classification table (all `ProviderName`s from `model-router.ts`, bucketed
  per §6).
- Focused test runs ×2, with exact `Test Files`/`Tests`/exit-code lines.
- Full-suite result, with delta against the `1589 passed | 3 failed | 12 skipped |
  exit 1` baseline (§10).
- Same-process and post-restart replay proof (§8 steps 3-6).
- Cap-rejection-before-provider-call proof (§8 steps 7-8).
- Unknown-price-rejection proof (§8 steps 9-10).
- Free-provider receipt proof (§8 step 11).
- Fallback-across-paid-providers behavior proof (§8 step 12).
- Evidence pack path(s) under `$HOME/.atlas/quarantine/evidence/p1b-router-<timestamp>/`.
- Merge recommendation (ready / blocked, with the specific blocker if blocked).

End the report with, verbatim, on its own line:

```
ATLAS P1-B SPEND AUTHORITY WIRED INTO PRODUCTION ROUTER — AWAITING CEO RECEIPT
```
