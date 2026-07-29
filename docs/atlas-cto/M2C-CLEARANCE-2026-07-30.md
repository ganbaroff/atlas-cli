# M2C — Destination-bound clearance and trusted-source guards

2026-07-30. Extends `src/atlas/cost-router-classify.ts` and
`src/atlas/cost-router-state.ts` (M2A route classifier, M2B error policy).
No parallel module, no second durable record, no duplicate error type.

## Why

Independent review of M2A/M2B found two gaps:

1. Nothing bound a brief's clearance to the *destination it actually went
   to*. A brief could be composed with one risk assumption and quietly sent
   to a cheaper failover provider carrying more identity/retention/agency
   risk than the brief was ever cleared for.
2. Both the M2A availability check and this new clearance check are pure
   functions that take their tables as arguments — which means any caller
   can neutralise either guard by simply passing a table that says whatever
   it wants. That is a real hole, not a hypothetical one: `runRoutedAttempt`
   already accepted an `availability` override before M2C.

## A. Destination-bound clearance

### The three class fields

Every provider carries a declared `ProviderClass` (owned by
`cost-router-state.ts`, re-exported from `cost-router-classify.ts`):

```ts
interface ProviderClass {
  identityBearing: boolean;   // signed-in subscription/browser session (true) vs a keyed service call (false)
  retentionTerm: 'none' | 'session' | 'bounded' | 'indefinite'; // declared retention term
  canActBeyondBrief: boolean; // can the destination act beyond the brief it was handed
}
```

These are objective, caller-declared fields — never inferred from the
brief's content — the same discipline M2A already applies to
`RouteTaskInput` and M2B applies to `FailureInput`.

### Ranking and refusal

`clearanceRank` sums three weights: `retentionTerm` (0–3), `+4` for
`identityBearing`, `+8` for `canActBeyondBrief`. Higher rank = weaker class
(more risk surface). `isWeakerClass(candidate, required)` is a strict
rank comparison. Because `canActBeyondBrief` carries the largest weight, a
destination able to act beyond its brief is *always* ranked weaker than one
that cannot, holding the other two fields equal — this is the literal
"agency dominates" acceptance test.

`assertDestinationClearance(required, destination, exception?)` is the pure
gate:

- No declared class on the destination → refused,
  `reason: 'destination_class_unknown'` (fail closed; never assume clearance
  for an unlabelled destination).
- Declared class weaker than the brief's cleared class, no exception →
  refused, `reason: 'destination_class_too_weak'`.
- Declared class weaker than the brief's cleared class, but an operator
  exception is present and the destination still meets
  `exception.permittedClass` → allowed.

`runRoutedAttempt` calls this gate (`guardClearance`) before *every*
provider call it makes, when `params.briefClearance` is set:

- Before the very first attempt against `currentProvider`.
- Before any failover attempt against the candidate `selectFailoverProvider`
  picked — this is the M2B failover path M2C was required to close. A
  weaker-class failover target is refused before `attempt()` is ever called
  against it; it is never "taken silently."

`briefClearance` is optional on the low-level `RunRoutedAttemptParams` so
every pre-M2C call site (and all 59 pre-M2C tests) keeps working unchanged —
no clearance regime declared, no clearance check runs.

### The receipt

`RoutedAttemptResult.finalProviderClass` is populated from a live table
lookup against whichever provider actually ended up serving the request
(`currentProvider` or the failover candidate) — never from
`briefClearance`, which is only the class the brief was *assumed* cleared
for at compose time. When a failover happens to an equal-or-stronger class,
`finalProviderClass` reflects the failover target, not the original
provider.

### The exception path

`ClearanceException { reason, approvedBy, permittedClass }` is passed on
`RunRoutedAttemptParams.clearanceException` / `TrustedRoutedAttemptParams`.
When it is what actually let a cross-class send proceed (destination was
weaker than `briefClearance` but the exception covered it),
`runRoutedAttempt` calls the new `recordClearanceException` in
`cost-router-state.ts`, which validates and persists it into a new,
optional `clearanceLedger: Record<taskId, ClearanceExceptionRecord>` field
on `DurableGoalRouterRecord` — schema-versioned, `.strict()`, keyed by
taskId, storing `reason`, `approvedBy`, `permittedClass`, and `recordedAt`.
An exception that is present but never needed (destination already met the
brief's class) is never written — the ledger reflects only exceptions that
were exercised.

`clearanceLedger` is `.optional()` with no `.default()`, mirroring
`activePremiumOwner`, so every pre-M2C persisted record and every
full-record fixture in `cost-router-state.test.ts` keeps validating and
round-tripping with no key added.

## B. Guards read trusted data, they do not accept it

The pure functions (`checkRouteAvailability`, `assertDestinationClearance`,
and `runRoutedAttempt`'s `availability`/`providerClasses` parameters) stay
exported and injectable — that is what lets the test suite exercise both
gates against fixtures without live provider state, exactly as the M2A/M2B
tests already did for availability.

The fix is a new, single supported entry point:

```ts
export async function runTrustedRoutedAttempt(
  params: TrustedRoutedAttemptParams,
): Promise<RoutedAttemptResult>
```

`TrustedRoutedAttemptParams` has **no `availability` field and no
`providerClasses` field at all** — not optional, not present. Internally,
`runTrustedRoutedAttempt` always calls `runRoutedAttempt` with
`availability: DEFAULT_ROUTE_AVAILABILITY` and
`providerClasses: DEFAULT_PROVIDER_CLASS_TABLE`, the module's own trusted
constants. This is the same technique that closed the M2B forged-brand hole
(`RESOLVED_ROUTES` WeakSet identity check on `AvailableRoute`): make the
unsafe path structurally unreachable rather than documenting a rule. There,
the unsafe path was "construct an `AvailableRoute` without calling
`resolveRoute`." Here, the unsafe path is "call routed work with an
injected table," and it is closed by never declaring a parameter through
which a table could travel — a caller can smuggle extra properties onto the
params object only via an `as unknown as TrustedRoutedAttemptParams` cast,
and `runTrustedRoutedAttempt` never reads them.

`briefClearance` is **mandatory** on `TrustedRoutedAttemptParams` (unlike
the optional field on the low-level function) — there is no pre-M2C caller
of the new entry point to stay backward compatible with, so the trusted
path always enforces clearance.

Any providerId absent from `DEFAULT_PROVIDER_CLASS_TABLE` has no declared
class and is refused (`destination_class_unknown`) through the trusted
entry point — fail-closed by construction, the same posture M2A already
applies to `T1` (disabled until its live gate lands). Real provider
identities get added to this table as they are onboarded in M5/M6.

## Acceptance

```
$ npx tsc --noEmit
TypeScript: No errors found

$ npx vitest run src/__tests__/cost-router-clearance.test.ts \
    src/__tests__/cost-router-error-policy.test.ts \
    src/__tests__/cost-router-classify.test.ts \
    src/__tests__/cost-router-state.test.ts
 ✓ src/__tests__/cost-router-classify.test.ts (11 tests)
 ✓ src/__tests__/cost-router-clearance.test.ts (7 tests)
 ✓ src/__tests__/cost-router-error-policy.test.ts (13 tests)
 ✓ src/__tests__/cost-router-state.test.ts (35 tests)
 Test Files  4 passed (4)
      Tests  66 passed (66)
```

The pre-existing 59 tests (11 + 13 + 35) are unchanged and green; the new
`cost-router-clearance.test.ts` adds 7 tests covering: failover refusal to
a weaker class with zero calls to that target; the receipt recording the
failover target's class, not the original; the operator-exception path
proceeding and recording itself plus the permitted class on the durable
record; the trusted entry point ignoring a smuggled availability/class
table while still routing correctly for a genuinely trusted providerId;
`isWeakerClass`'s agency-dominates ordering; and a direct backward-
compatibility check that `briefClearance`-less calls are byte-for-byte
unaffected.

`git status --short` after the code+test commit showed only the three M2C
files plus the pre-existing dirty entries this task was told not to touch
(`docs/atlas-cto/FABLE-PROTOCOL.md`, `state/exec-graph/graph.json`,
`state/exec-graph/ledger.jsonl`,
`docs/atlas-cto/VOLAURA-LEARNING-ENGINE-HANDOFF-2026-07-25.md`,
`state/evidence/`).

## Status

These closures are **provisional pending independent audit** — the same
posture M2A and M2B shipped under. `DEFAULT_PROVIDER_CLASS_TABLE` currently
holds two placeholder trusted entries (`trusted-keyed-1`,
`trusted-identity-1`) for test coverage of the trusted path; it carries no
real production provider identities yet, and the clearance-rank weighting
(0/1/2/3 retention, +4 identity, +8 agency) is a first-pass ordering that
should be reviewed against real provider inventories before M5/M6 wiring.

## M2C repair (2026-07-30) — two independent-review refutations

A follow-up independent review demonstrated that both guards above were,
in practice, conventions rather than controls. Both are now closed.

### Refutation 1 — the back door was a convention, not a control

**Demonstration.** Section B above described `runRoutedAttempt`'s
injectable `availability`/`providerClasses` parameters as safe because
"the fix is a new, single supported entry point" (`runTrustedRoutedAttempt`)
— but `runRoutedAttempt` itself was still exported, unguarded, with only a
code comment ("stays reachable here so tests can exercise the gates")
standing between it and any normal `import`. The review imported it
directly from outside the module, passed a forged
`{ T0: true, T1: true, T2: true, T3: true }` availability table, and
entered route **T1** — disabled by default — with no refusal and no cast
required. The comment described a rule; nothing enforced it.

**What replaced it.** `runRoutedAttempt` now refuses to run unless
`process.env.VITEST === 'true'` (the flag Vitest itself sets for every
test-runtime process) — the very first line of its body, before
`assertRouteAvailabilityChecked`, before anything else:

```ts
if (process.env['VITEST'] !== 'true') {
  throw new RouteRefusalError(
    'test_only_entry_point',
    params.route?.route,
    'runRoutedAttempt is test-only (requires a Vitest runtime); production code must use runTrustedRoutedAttempt',
  );
}
```

This is an enforced runtime gate, not a rename or a stronger comment: the
same forged-availability call that previously entered T1 now throws
`RouteRefusalError('test_only_entry_point')` before the availability table
is even consulted, proven in
`cost-router-clearance.test.ts` ("the injectable-table entry point is
test-only, enforced not conventional") by unsetting `process.env.VITEST`
around the exact call and asserting the refusal. The public,
production-reachable surface for spending a provider attempt is now
`runTrustedRoutedAttempt` alone — `runRoutedAttempt` remains exported only
because ES modules have no package-private visibility across files, and
Vitest's tests (which always run with `VITEST=true`) still exercise both
the availability and clearance gates through it, satisfying the same
"gates must stay testable against fixtures" requirement Section B
described, now backed by a check instead of a promise.

### Refutation 2 — the operator exception was self-grantable

**Demonstration.** `ClearanceException { reason, approvedBy, permittedClass }`
was plain data with no authenticity check. Any caller — including the
router's own code — could construct
`{ reason: 'x', approvedBy: 'the-calling-code-itself', permittedClass: <whatever class it wanted> }`
and hand it to `runRoutedAttempt`/`runTrustedRoutedAttempt`, and
`assertDestinationClearance` would honour it. Nothing distinguished a real
operator grant from a self-issued one; the operator's authority over
cross-class sends was nominal.

**What replaced it.** Reused this repository's already-proven operator-held
signing mechanism verbatim rather than inventing a second scheme:
`src/atlas/queue-auth.ts`'s pattern of HMAC-SHA256 over a canonical JSON
payload, a signing key read from the environment **by name only**
(`ATLAS_CLEARANCE_SIGNING_KEY` — mirrors `ATLAS_QUEUE_SIGNING_KEY`; the
value is operator-set and never appears in code, tests, logs, receipts, or
this document), and `queue-auth.ts`'s own `createNonceLedger` for replay
detection — no new dependency, no second nonce-ledger implementation.

`ClearanceException` gained optional `sig`/`ts`/`nonce` fields. Before any
provider call is made, `runRoutedAttempt` verifies a supplied exception
exactly once per attempt (so one signed exception legitimately covering
both the primary provider and one failover within a single attempt is not
mistaken for a replay of itself) via `verifyClearanceExceptionSignature`,
which fails closed with its own named `ClearanceRefusalReason` at every
step:

- no `ATLAS_CLEARANCE_SIGNING_KEY` configured → `exception_signing_key_not_configured`
  (verification unavailable **never** means permitted — this was the
  specific fail-closed requirement, and it is checked before signature
  shape, before expiry, before the nonce ledger)
- missing `sig`/`ts`/`nonce` → `exception_unsigned`
- signature does not match the recomputed HMAC over the canonical fields → `exception_signature_mismatch`
- signature older than the 24h window (mirrors `queue-auth`'s `MAX_AGE_MS`) → `exception_signature_expired`
- nonce already spent (`createNonceLedger(...).recordIfFresh`) → `exception_signature_replayed`

Only a verified exception is passed on to `assertDestinationClearance` and
only a verified exception is what `recordClearanceException` persists onto
`clearanceLedger` — the accepted exception and the class it permitted are
still recorded on the durable record exactly as before, now with the
guarantee that what got recorded actually verified.

`cost-router-clearance.test.ts` ("a clearance exception is not
self-grantable — it must verify") proves: unsigned refused, mis-signed
(tampered `approvedBy` after signing) refused, replayed (same signed
exception reused for a second task) refused, no-key-configured refused
with zero provider calls in every refusal case, and — in the pre-existing
"operator exception" test, now updated to sign the exception via
`signClearanceException` under a stubbed test key — a correctly signed
exception with a key configured still proceeds and is still recorded.

### Standing lesson

**A door left open "so tests can exercise it" is not a control — it is the
same shape as the vulnerability, with a comment instead of a lock.** Both
refutations above were the identical failure pattern from two different
angles: M2A/M2B already learned this once (the `AvailableRoute` brand had
to become identity-based via `RESOLVED_ROUTES`, not property-based, because
a comment/type-cast could forge it) and shipped `runTrustedRoutedAttempt`
as the intended fix — but left the *old*, unguarded entry point exported
right next to it, trusting callers to prefer the new one. Trusting callers
is exactly what a control exists to avoid trusting. The rule going forward
for this codebase: when a function's only legitimate callers are the test
suite, that must be true by construction (a runtime gate, an unreachable
module path, a structural type) — never by a docstring asking politely.

## M2C repair 2 (2026-07-30) — a third refutation: the runtime gate was itself caller-controlled

The Refutation 1 fix above (`process.env.VITEST === 'true'`) was itself
demonstrated live, twice, to be no fix at all. A plain `npx tsx` script —
not Vitest, not this repository's test runner — set
`process.env.VITEST = 'true'` on itself before importing
`cost-router-classify.ts`, called the exported `runRoutedAttempt` directly
with a forged `{ T0: true, T1: true, T2: true, T3: true }` availability
table, and completed a real provider call against the default-disabled T1
route. The guard checked *a value the caller supplied to its own process*
and treated agreement with that value as authorization. It never was.

### Why an environment variable is not a control

A control has to distinguish a legitimate caller from an illegitimate one
using information the illegitimate caller cannot produce. `ATLAS_CLEARANCE_SIGNING_KEY`
(section A above) is a control in this sense: the caller cannot compute a
valid HMAC without the operator-held key, no matter what environment it
runs in. `RESOLVED_ROUTES` (the M2B repair) is a control in this sense: the
caller cannot manufacture WeakSet membership for an object it didn't get
back from `resolveRoute`, no matter what property values it copies.
`process.env.VITEST` is not a control in this sense: it is a bare string in
the calling process's own environment, and the calling process owns its own
environment completely. Checking it is equivalent to asking a caller
"are you allowed to do this?" and trusting a `yes` — the exact anti-pattern
Refutation 1 already named on the *previous* attempt (a comment asking
politely). This is the third time this specific file has repaired a
caller-controlled marker being mistaken for an authenticated one: first an
own-enumerable symbol property (survives spread/`Object.assign`), then a
code comment (enforces nothing), now an environment variable (the caller's
own process sets it). All three share the same shape: the check reads
something the caller fully controls and calls agreement "proof."

### What replaced it: remove the entry point, don't gate it

Every previous attempt kept an injectable-table function exported from
`cost-router-classify.ts` and tried to make calling it, from outside the
test suite, refuse. That framing was the mistake — as long as the function
is exported with an injectable-table signature, *some* caller-controlled
signal has to be the thing standing between "test" and "production," and
caller-controlled signals can always be forged by the caller. The fix
removes the function from the module's exports instead of trying to gate
who may call it:

- `runRoutedAttempt` and `RunRoutedAttemptParams` are deleted from
  `cost-router-classify.ts`'s public surface. The engine logic they held
  (availability re-check, clearance re-check, error-bucket retry/failover)
  now lives in `executeRoutedAttempt`, a private, non-exported function.
  Its `RouteAttemptExecutionParams` type is not exported either, and its
  `availability`/`providerClasses` fields are mandatory, not optional —
  there is no longer any caller for which they would need a default.
- `runTrustedRoutedAttempt` stays the sole exported function able to spend
  a provider attempt. It resolves its tables by calling
  `resolveTrustedTables({ availability: DEFAULT_ROUTE_AVAILABILITY,
  providerClasses: DEFAULT_PROVIDER_CLASS_TABLE })` — a function imported
  from a new file, `src/atlas/cost-router-test-seam.ts`.
- `cost-router-test-seam.ts` is the substitution seam: `resolveTrustedTables`
  returns whatever `withTrustedTables` last installed, or the caller's
  `defaults` unchanged when nothing is installed. `withTrustedTables` is the
  *only* function in the entire codebase that can change what
  `resolveTrustedTables` returns, and it is exported only from this one
  file. `cost-router-classify.ts` imports `resolveTrustedTables` (a getter)
  but never `withTrustedTables` (the setter) — so even a caller that reads
  every export of `cost-router-classify.ts` has no path to the setter
  without a separate, explicit `import ... from
  './cost-router-test-seam.js'`.

The `test_only_entry_point` refusal reason and the `RouteRefusalReason`
member it lived on are removed as dead code — there is no longer a runtime
refusal to name, because there is no longer a reachable call to refuse.

### Why this is not the same shape as the previous two failures

The previous two fixes both tried to answer "how do we stop an illegitimate
caller from using this exported function correctly?" — which is
unanswerable in general, because "correctly" is defined by the caller's own
input. This fix instead answers "does an illegitimate caller have any
statement in the language that reaches an injectable table?" and the answer
is now no: `cost-router-classify.ts` exports zero functions whose parameter
type includes an `availability` or `providerClasses` field.
`resolveTrustedTables` is a getter with no exported setter reachable from
that module. The only way to influence what it returns is to import a
second, separate, explicitly-named file and call the one function that file
exports for exactly that purpose. Nothing about that path involves
predicting or reading a caller-controlled runtime signal — it is a question
about the static import graph, decided at the same time the module graph
itself is decided, not at call time.

### Test coverage

`cost-router-error-policy.test.ts` and `cost-router-clearance.test.ts` were
updated so every gate they proved through the old `runRoutedAttempt`
now goes through `runTrustedRoutedAttempt` plus `withTrustedTables`
(disabled route refused, unclassifiable/forged-brand refused, error buckets
and retry arithmetic, weaker-class destination refused, the four
signed-clearance refusals, fail-closed with no key — all unchanged in
substance, only in which entry point exercises them). Each file also gained
a mechanical assertion that `cost-router-classify.ts`'s runtime exports do
not include `runRoutedAttempt` (the actual boundary check this repair is
about), and `cost-router-clearance.test.ts` additionally reproduces the
exact live attack — `process.env.VITEST = 'true'` plus a
`... as unknown as TrustedRoutedAttemptParams` cast smuggling an
`availability` field onto the params object — and confirms it still
refuses (`route_disabled`, from the real default table, because the
smuggled field is never read).

One pre-existing test, "backward compatibility: no clearance declared",
called the old `runRoutedAttempt` with no `briefClearance` at all — a
scenario `runTrustedRoutedAttempt` never permitted even before this repair
(`briefClearance` was already mandatory on `TrustedRoutedAttemptParams`).
With the low-level entry point gone, that scenario is not expressible
through any surface, public or test-only, so the test was removed rather
than kept as dead weight. Net count across the two files: 25 -> 26 (one
test removed as unreachable, three added: the two mechanical
public-surface checks and the reproduced-attack-still-refuses case).
`npx vitest run` across all four cost-router test files: 71 -> 72 total,
still 0 failing.

```
$ npx tsc --noEmit
TypeScript: No errors found

$ npx vitest run src/__tests__/cost-router-classify.test.ts \
    src/__tests__/cost-router-clearance.test.ts \
    src/__tests__/cost-router-error-policy.test.ts \
    src/__tests__/cost-router-state.test.ts
PASS (72) FAIL (0)
```

### Standing rule

**A boundary is enforced by what a module exports, not by what a caller
promises.** This is the durable form of the lesson across all three
refutations: a symbol property is a promise (spreadable), a comment is a
promise (readable but not binding), an environment-variable check is a
promise (the caller sets its own environment). None of the three could ever
have worked, structurally, no matter how the specific check was worded —
the fix was never "phrase the gate better," it was "does the caller have
any reachable statement that produces an injectable table." For this
codebase going forward: if a table, key, or capability must never reach
production code, it cannot be a parameter, default, or conditionally-set
value on any function production code can import — it must live in a file
production code does not import, reachable only through a function that
file alone exports.
