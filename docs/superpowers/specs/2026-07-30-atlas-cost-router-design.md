# ATLAS Cost Router and Research Broker Design

**Date:** 2026-07-30
**Status:** revised after external adversarial review; awaiting Yusif review
**Owner:** Codex SOL
**Decision authority:** Yusif
**Target:** existing ATLAS/atlas-cli codebase; no `ATLAS.next`

## 1. Outcome

ATLAS must choose the cheapest capable execution layer before a premium model
starts work. Public web research goes to an already-paid research subscription
when possible. Local code and private context stay local. Fable, Opus, and
Codex SOL receive compact evidence instead of performing ordinary search or
waiting inside long-running research jobs.

The current Cost Router is a prerequisite for the future autonomous
multi-provider swarm. It is not a competing orchestrator.

Success means:

- ordinary public lookup does not consume Claude or Codex premium reasoning;
- a useful 30–45 minute research job can finish without keeping a premium model
  or full conversation context alive;
- policy, permission, seat, and capability failures stop after the first
  denial;
- external transmission is limited to a pre-send sanitized public brief;
- every run produces a bounded, verifiable receipt and one exact next action;
- Yusif controls goals, privacy exceptions, metered spend, and irreversible
  decisions without acting as routine courier.

## 2. Verified Baseline

Existing ATLAS already contains:

- cost-ordered model routing in `src/model-router.ts`;
- bounded research lifecycle and structured artifacts in
  `src/research-swarm/*`;
- deterministic swarm completion checks in `src/swarm-exec/*`;
- provider health and spend controls;
- a local Browser Hand and Fable protocol hook;
- an existing research-swarm status of `RESEARCH_ONLY_LIMITED`.

Current limitations:

- latest stored research-swarm runs contain no successful multi-provider proof;
- current perspective configuration names two Anthropic workers, two
  unsupported `cerebras` workers, and one NVIDIA worker;
- Perplexity is not registered in the ATLAS provider router;
- existing secret scanning happens after a research artifact is built, not
  before a prompt leaves the machine;
- the existing swarm calls model providers, not subscription-backed web
  research products;
- live Fable evidence found exact tool-count drift and a Workflow topology that
  repeatedly collided with the single-worker lock;
- provisional state-root Wave A commit `6f54582` exists locally, but Codex
  classified it `MODIFY`: relative override values remain CWD-dependent and
  its inventory document repeats rejected store counts;
- Perplexity is reachable through an authenticated-looking Codex in-app browser
  session, which proves interactive access only, not a durable unattended ATLAS
  connector;
- ChatGPT Deep Research and Gemini Deep Research browser sessions remain
  unverified until opened and authenticated.

Current deterministic verification:

- Fable protocol hook suite: 29/29 passed;
- focused research-swarm routing/lifecycle/eval/provider-health suite:
  19/19 passed;
- these tests prove fail-closed mechanics, not live provider availability.

External review closure:

- two bounded no-tool reviews completed on `claude-opus-5`; two attempts on
  `claude-fable-5` failed with server-side `529` and produced no review;
- both Opus reviews saw the compact prompt, not this complete specification;
- Codex accepted durable goal-level router state, destination-bound privacy,
  objective route predicates, explicit error buckets, and fail-closed
  unavailable routes;
- Codex modified the proposed async rule to one durable scheduled resume at a
  time with a bounded inspection count, rather than one total inspection;
- Codex rejected claims that this full design had no pre-send privacy gate or
  treated browser subscriptions as APIs. Those controls already existed but
  needed stronger destination and retention binding.

## 3. Approved Decisions

### 3.1 External data policy

ATLAS may automatically send only a sanitized public web-research brief.

Automatic external transmission must exclude:

- source code and code fragments;
- local files, file contents, diffs, paths, and repository identifiers;
- private documents, memories, chat history, transcripts, logs, and traces;
- credentials, tokens, cookies, session material, and secret-like strings;
- personal data and other private identifiers;
- attachments and uploads.

If the sanitizer cannot prove the brief is public and non-sensitive, routing
stays local. The system must not “redact and hope.”

### 3.2 Provider policy

Default external route uses existing subscription-backed browser sessions:

1. Perplexity for quick/current web research;
2. Gemini Deep Research for long, cited research;
3. ChatGPT Deep Research as another subscription-backed research lane;
4. another connected public web provider only after its own capability proof.

Provider order is adjusted by availability, remaining visible quota, task
class, latency, and prior health. Providers are not launched in parallel for an
ordinary lookup.

Metered API access is disabled by default. A consumer Pro subscription must not
be treated as API authorization or API credit. Enabling Perplexity, Gemini, or
OpenAI API billing requires a separate Yusif spend decision.

### 3.3 Premium-model policy

- One premium reasoning owner per phase.
- Fable, Opus, and Codex SOL do not browse for facts already obtainable through
  a cheaper connected research lane.
- Premium models receive normalized claims, citations, dissent, unknowns, and
  local verification receipts, not full external transcripts.
- No child may create grandchildren.
- A second premium model is allowed only for material independent verification
  or conflict resolution.

### 3.4 Codex SOL execution policy

Codex SOL is the local implementation and verification owner, but it must not
use premium reasoning as an idle process manager.

- Run deterministic local preflight before any model delegation.
- Route sanitized public-web work to T1 instead of researching it inside Codex
  or Claude.
- Keep core implementation and architectural judgment with Codex SOL.
- Delegate only one concrete, independent mechanical lane when parallelism
  materially helps; default one worker, no grandchildren.
- Do not switch or upgrade models merely to write code.
- Never keep a premium turn open while a browser research job or worker is
  waiting. Persist the work order, end the turn, and resume from its receipt.
- Use compact handoffs: exact task, owned paths, done-bar, stop rule, budget,
  and receipt shape. Do not forward full history or unrelated files.
- Stop a route on its first permission, policy, seat, invariant, privacy, or
  capability denial.
- Treat silence as `UNKNOWN`. Use event waits no longer than 60 seconds; do not
  infer that a writer is dead.
- Verify worker output with local commands before claiming completion.

## 4. Architecture

```text
Task
  -> Cost Router
      -> Objective Task Predicate
      -> Task Class + Goal Budget
      -> Capability/Health Check
      -> Candidate Provider Profile
      -> Destination-Bound Privacy Gate
      -> Immutable Work Order
          -> T0 Deterministic Tool
          -> T1 Subscription Browser Research
          -> T2 Bounded Local Worker
          -> T3 Premium Reasoning
          -> T4 Existing Research Swarm (disabled by default)
      -> Receipt Normalizer
      -> Local Verifier
      -> Exact Next Action
```

Cost Router is the only component allowed to choose a tier. Provider adapters
execute an already-decided work order; they do not reclassify tasks, widen
privacy scope, create subagents, or promote themselves to completion authority.

Existing research-swarm remains a capability behind Cost Router. Exec-graph
remains task-lifecycle authority. Cost Router does not introduce another task
database or transition authority.

## 5. Work Order Contract

Every routed task has one immutable work order:

```ts
interface CostRouterWorkOrder {
  schemaVersion: 1;
  goalId: string;
  taskId: string;
  phaseId: string;
  taskClass:
    | "lookup"
    | "deep_research"
    | "local_mechanical"
    | "local_complex"
    | "premium_synthesis"
    | "multi_provider_research";
  sensitivity: "public" | "private" | "secret" | "unknown";
  outboundPolicy: "allowed_sanitized" | "local_only";
  providerClass:
    | "deterministic"
    | "subscription_browser"
    | "local_worker"
    | "premium"
    | "research_swarm";
  selectedProvider: string;
  providerProfileId: string;
  providerProfileHash: string;
  routeTrigger: string;
  privacyDecisionId?: string;
  costClass: "zero_marginal" | "subscription_included" | "metered_blocked";
  limits: {
    wallClockMs: number;
    toolCalls?: number;
  };
  retryPolicy: {
    invariantRetries: 0;
    transientRetries: 1;
    providerFailovers: 1;
  };
  requiredEvidence: string[];
  verifier: string;
  createdAt: string;
}
```

The implementation may add derived fields but may not weaken the approved
limits or privacy policy without a new decision.

### 5.1 Objective route predicates

The classifier is a pure function over structured task metadata. It performs no
model call. Missing or contradictory metadata returns
`route_blocked:needs_classification`; it never promotes itself to T3.

| Predicate | Route | Required recorded trigger |
|---|---|---|
| registered deterministic capability fully satisfies request | T0 | capability ID |
| `requiresFreshWeb=true`, `sensitivity=public`, one-provider evidence sufficient | T1 lookup | `fresh_public_web` |
| `requiresDeepResearch=true`, `sensitivity=public`, managed background job available | T1 deep research | `deep_public_research` |
| approved local plan, owned paths, bounded mechanical change | T2 mechanical | plan and scope IDs |
| approved local plan, bounded complex slice | T2 complex | plan and slice IDs |
| unresolved architecture decision with alternatives | T3 | architecture decision ID |
| two verified receipts materially conflict | T3 | conflicting receipt IDs |
| independent verification explicitly required by gate | T3 | gate ID |
| `multiProviderRequired=true` and live gate is `READY_FOR_RESEARCH` | research swarm | evaluation ID |

Natural-language ambiguity is not a T3 trigger. A task may enter T3 only with
one objective trigger above in its immutable work order. One task may escalate
to T3 at most once.

A phase is the interval from one accepted immutable work order to its terminal
receipt. Phases for the same goal cannot overlap premium ownership. A new phase
requires the previous phase's terminal receipt; renaming or splitting a task
does not reset its escalation ledger.

### 5.2 Durable goal router record

All counters and open handles are durable before any live route is enabled.
Logical storage path:

```text
<ATLAS_STATE_ROOT>/cost-router/goals/<goal-id>.json
```

The accepted state-root resolver must provide the path. Writes use one
single-writer lock, monotonic revision, atomic replace, and cold-read
validation.

```ts
interface DurableGoalRouterRecord {
  schemaVersion: 1;
  goalId: string;
  revision: number;
  activePremiumOwner?: {
    phaseId: string;
    taskId: string;
    seat: "fable" | "opus" | "codex-sol";
    acquiredAt: string;
    expiresAt: string;
  };
  escalationLedger: Record<string, 0 | 1>;
  budget: {
    maxLocalSlices: number;
    usedLocalSlices: number;
    maxResearchJobs: number;
    usedResearchJobs: number;
    maxPremiumEscalations: number;
    usedPremiumEscalations: number;
    meteredSpendLimitUsd: 0;
  };
  retryLedger: Record<string, {
    denialAttempts: number;
    transportRetries: number;
    providerFailovers: number;
  }>;
  openAsyncHandles: AsyncResearchHandle[];
  updatedAt: string;
}
```

Every goal must carry explicit non-null ceilings. Missing, corrupt, expired, or
unwritable goal state blocks routing. Initial ceiling values remain a Yusif
review item; they are configuration, not a reason to weaken per-task limits.

## 6. Task Classes and Limits

| Task class | Default route | Limit | Completion evidence |
|---|---|---:|---|
| `lookup` | deterministic tool or one subscription web provider | 5 minutes | answer plus direct sources |
| `deep_research` | one subscription-backed managed research job | 45 minutes | cited report plus provider job receipt |
| `local_mechanical` | one LUNA/Sonnet worker | 15 tool calls / 15 minutes | scoped diff/artifact plus command evidence |
| `local_complex` | one bounded local executor | 25 tool calls / 20 minutes | checkpointed slice plus command evidence |
| `premium_synthesis` | one Fable/Opus/SOL owner | compact evidence only; no research children | decision with accepted/rejected evidence |
| `multi_provider_research` | existing ATLAS research-swarm | disabled until live gate | two-provider source-bearing receipt |

A long task is split before dispatch when its local execution scope exceeds one
bounded slice. Runtime extension is not a substitute for decomposition. A
split consumes the parent goal's durable slice ceiling; creating more task IDs
cannot reset that ceiling.

## 7. Pre-Send Privacy Gate

Privacy Gate runs after a candidate provider profile is selected but before
any browser or network action. The brief composer and privacy checker are
separate deterministic components. Neither can certify its own output.

It performs:

1. sensitivity classification;
2. secret and credential-pattern detection;
3. local path, repository identity, transcript, log, diff, and code detection;
4. public-brief construction;
5. a second scan of the exact outbound text;
6. provider-profile validation;
7. an allow/deny decision bound to the exact outbound bytes and destination.

The outbound text is the only task content a provider adapter receives.
Adapters cannot access the original local prompt.

The decision ID commits to:

```text
SHA256(outbound bytes + destination provider ID + provider-profile hash)
```

Any retry or failover to another destination requires a new decision. A
provider with weaker or unknown identity, retention, or navigation controls is
not an automatic cheap failover; it requires a Yusif privacy exception.

Fail-closed conditions:

- sensitivity is `secret` or `unknown`;
- any forbidden data class remains;
- the brief depends on an attachment or local file;
- the sanitizer or receipt store is unavailable;
- destination provider is not explicitly registered;
- provider retention or identity profile is stale or unknown;
- exact destination cannot be determined.

Privacy receipt stores classifications and hashes, never detected secret
values.

## 8. Subscription Browser Adapter

V1 uses existing paid consumer accounts through a user-authenticated managed
browser. This lane avoids a separate metered API bill but is not equivalent to
an API integration.

Adapter contract:

```ts
interface SubscriptionResearchAdapter {
  capability(): Promise<{
    available: boolean;
    authenticated: boolean;
    supportsBackgroundJobs: boolean;
    reason?: string;
  }>;
  submit(sanitizedBrief: string): Promise<{
    provider: string;
    remoteJobId?: string;
    remoteUrl?: string;
    state: "submitted" | "completed" | "blocked";
  }>;
  inspect(job: ResearchJobRef): Promise<ResearchJobStatus>;
  collect(job: ResearchJobRef): Promise<ExternalResearchReceipt>;
}
```

Browser safety rules:

- never inspect or extract cookies, local storage, password managers, or session
  tokens;
- never ask Yusif to paste a password, OTP, API key, or recovery code into
  chat;
- Yusif performs login, MFA, CAPTCHA, new terms acceptance, purchases, and
  account recovery directly in the visible browser;
- never upload files under the approved automatic external-data policy;
- never click upgrade, purchase, connector permission, or account-security
  actions automatically;
- a lost login is a capability block, not a reason to fall back to a premium
  model;
- UI changes fail closed and produce a browser-adapter receipt.

ATLAS must label this route `subscription_browser`, not `api`. Usage receipts
record job count and provider-reported quota signals when visible. They must
not fabricate dollar cost for subscription usage.

Each destination has a versioned profile:

```ts
interface ProviderPrivacyProfile {
  schemaVersion: 1;
  providerId: string;
  route: "subscription_browser" | "api";
  identityExposure:
    | "logged_in_consumer_identity"
    | "service_account"
    | "contractual_api_identity";
  retentionBasis: "consumer_terms" | "api_terms" | "unknown";
  termsUrl: string;
  termsReviewedAt: string;
  adapterNavigation: "provider_ui_only";
  remoteResearchNavigation: "public_web" | "unknown";
  allowedSensitivity: "public_only";
}
```

Browser adapters may submit the approved brief and inspect or collect the
matching job. They may not follow provider-suggested actions, broaden the
question, upload context, or navigate outside the provider research UI.

## 9. Asynchronous Research Lifecycle

Deep Research submission and resumption are separate operations. The premium
seat never owns the wait.

```ts
interface AsyncResearchHandle {
  handleId: string;
  goalId: string;
  taskId: string;
  phaseId: string;
  providerId: string;
  providerProfileHash: string;
  remoteJobId?: string;
  remoteUrl?: string;
  submittedAt: string;
  expiresAt: string;
  nextResumeAt: string;
  inspectionCount: number;
  maxInspections: number;
  outputRef: string;
  state: "submitted" | "scheduled" | "completed" | "failed" | "expired";
}
```

1. Cost Router persists the sanitized work order.
2. Browser adapter submits one job and atomically persists its durable handle.
3. Exactly one deterministic resume event is scheduled in
   `nextResumeAt`; the premium model turn ends.
4. No status probe occurs before that event.
5. The scheduler cold-reads the handle and either:
   - collects a completed result;
   - records one bounded inspection and schedules one later resume according to
     the predeclared backoff, while below `maxInspections` and `expiresAt`; or
   - closes it as failed/expired.
6. Completed result is normalized into claims, citations, dissent, unknowns,
   and provider metadata.
7. Local verifier checks material local claims and cited web claims.
8. Only a terminal normalized receipt may open the next premium phase, and only
   with a valid objective T3 trigger.

No model is allowed to hold full context while polling.

An external managed job may remain `in_progress` within its approved 45-minute
window because no premium model is waiting. Each handle has only one live
resume event and a bounded inspection count, so silence cannot become an
unbounded polling loop. At expiry, an expired or unknown handle resolves
locally to `async_expired` without another provider call. If the site offers no
safe cancel operation, the receipt records `remote_may_continue`; ATLAS must
not submit a duplicate job automatically.

## 10. Progress and Stop Rules

### 10.1 Local workers

Valid progress:

- a new scoped file artifact;
- a diff within owned files;
- a command result with exit code;
- a new cited source;
- a durable receipt or test result.

“Still working,” hidden chain-of-thought, repeated inspection, and unchanged
poll output are not progress.

One extension is allowed only when a new artifact proves the worker is near its
predeclared done-bar. The extension cannot exceed a new bounded slice and must
be represented as a new work order.

### 10.2 Failures

- permission, policy, seat, invariant, privacy, or capability denial:
  zero retries, immediate terminal receipt;
- ambiguous, unclassified, authentication, and HTTP authorization errors:
  denial bucket, zero retries;
- ordinary network or provider transient:
  one same-provider retry;
- continued transient:
  one failover to a different cheap provider only after a new
  destination-bound privacy decision;
- expired or unknown async handle:
  local `async_expired` terminal receipt, zero provider calls;
- disabled or unavailable research route:
  named blocker and refusal; never answer from local model memory;
- no automatic Fable, Opus, Sonnet, or Codex premium fallback;
- identical denial never receives a rewritten prompt;
- missing or corrupt enforcement state fails closed;
- uncertain worker liveness is `UNKNOWN`, never `DEAD`.

### 10.3 Error-shape table

| Observable shape | Bucket | Same-provider attempts | Next action |
|---|---|---:|---|
| policy, permission, seat, invariant, privacy, capability, authentication | `denial` | 1 | terminal blocker |
| HTTP 401/403, ambiguous, or unclassified | `denial` | 1 | terminal blocker |
| connection reset, DNS failure, timeout, HTTP 408, known retryable 5xx/529 | `transport` | 2 | one equal-or-stronger privacy-class failover |
| HTTP 429 with explicit retry signal allowed by provider profile | `transport` | 2 | one equal-or-stronger privacy-class failover |
| quota exhausted or 429 without an allowed retry signal | `route_unavailable` | 1 | one equal-or-stronger subscription route or blocker |
| async handle missing, corrupt, unknown, or expired | `async_expired` | 0 | local terminal receipt; no provider call |
| research route disabled or no provider capability | `route_unavailable` | 0 | named blocker; no model substitute |
| goal or task ceiling exhausted | `budget` | 0 | named blocker; require a new approved budget |

Any shape not matched by this table is `denial`. Provider failover always
re-runs the destination-bound privacy gate.

## 11. Fable Enforcement

Before Fable may launch another worker, implementation must close:

- exact tool-call accounting against the declared budget;
- direct rejection of nested Workflow topology under single-worker policy;
- first-invariant-denial terminal latch;
- durable worker identity and state across parent/child calls;
- no blocking polling or long sleep;
- receipt delivery without making Yusif copy results between systems.

Fable remains planner/integrator. It may perform a short no-tool design review.
Hands-work goes to one bounded executor. Codex SOL independently verifies local
claims and owns completion evidence.

## 12. Research Receipt

Every external result normalizes to:

```ts
interface ExternalResearchReceipt {
  schemaVersion: 1;
  goalId: string;
  taskId: string;
  phaseId: string;
  provider: string;
  providerProfileId: string;
  providerProfileHash: string;
  routeTrigger: string;
  route: "subscription_browser" | "api";
  costClass: "subscription_included" | "metered";
  submittedAt: string;
  completedAt?: string;
  elapsedMs: number;
  status:
    | "success"
    | "insufficient_evidence"
    | "timeout"
    | "async_expired"
    | "route_unavailable"
    | "budget_blocked"
    | "provider_failure"
    | "policy_blocked"
    | "remote_may_continue";
  errorBucket:
    | "none"
    | "denial"
    | "transport"
    | "async_expired"
    | "route_unavailable"
    | "budget";
  privacy: {
    outboundAllowed: boolean;
    reasonCodes: string[];
    outboundHash?: string;
    decisionId?: string;
    destinationProviderId?: string;
  };
  attempts: number;
  failovers: number;
  claims: Array<{
    text: string;
    sourceUrls: string[];
    confidence: "verified_source" | "inference" | "unknown";
  }>;
  dissent: string[];
  unknowns: string[];
  verifierStatus: "accepted" | "rejected" | "unverified";
  blocker: string | null;
  nextAction: string;
}
```

A provider's prose cannot set `verifierStatus`. Local verifier derives it.
Missing citations cannot produce `success` for a web-fact task.

## 13. CEO Reporting

Every substantive status uses:

```text
current step / evidence / blocker / next command
```

Every final CEO-facing result ends with exactly one of:

```text
Тебе сейчас: ничего.
```

or one exact action. Yusif is never asked to relay provider output. When a
manual login is required, the action names one site and one browser window; no
credential crosses chat.

## 14. Existing Research-Swarm Activation Gate

Research-swarm remains disabled by default until all conditions pass:

1. two distinct web-capable providers return source-bearing results for the
   same sanitized task;
2. a secret-bearing and a private-file fixture are blocked before any network
   request;
3. one 30-minute background job completes without a premium model waiting;
4. one provider outage performs exactly one cheap failover;
5. one invariant denial performs zero retries;
6. every run produces complete privacy, provider, elapsed-time, attempt,
   citation, and verifier evidence;
7. all-provider failure cannot produce success;
8. deterministic evaluation changes verdict from `RESEARCH_ONLY_LIMITED` to
   `READY_FOR_RESEARCH`.

Swarm is selected only when independent perspectives materially improve a
decision. Ordinary lookup stays single-provider.

## 15. Implementation Decomposition

This design spans dependent subsystems. Implementation must proceed as bounded
slices, not one long mission.

### Slice A — enforcement repair

- repair and test exact Fable counter behavior;
- reject nested Workflow launch before child creation;
- live-prove one bounded executor path and first-denial stop.

### Slice B — pure Cost Router core

- implement model-free route predicates, immutable work orders, phase
  definition, goal ceilings, and error buckets;
- implement separate brief composer and destination-bound pre-send Privacy
  Gate;
- use dependency-injected provider capabilities;
- no live network call.

### Slice C — durable job state

- depend on an accepted, repaired `ATLAS_STATE_ROOT` resolver;
- persist goal router records, premium leases, escalation/retry/slice ledgers,
  async handles, work orders, and receipts outside code checkout;
- cold-read and replay without repository state.

Current provisional commit `6f54582` does not satisfy this dependency. It must
first reject or stably interpret relative overrides, pass CWD-invariance tests,
and correct its initial-store inventory claims. Background research must not be
enabled before this slice passes.

### Slice D — subscription browser providers

- integrate Perplexity first;
- prove ChatGPT Deep Research and Gemini Deep Research sessions separately;
- add submit, inspect, collect, and login-block receipts;
- keep metered APIs disabled.

### Slice E — swarm promotion

- route existing research-swarm through Cost Router;
- remove unsupported provider configuration;
- run the activation gate;
- retain `RESEARCH_ONLY_LIMITED` on any failed condition.

Each slice gets its own implementation plan, tests, command receipt, local
review, and independent verification. No slice may broaden physical
consolidation authority.

## 16. Test Strategy

### Unit tests

- same structured input yields the same route without any model call;
- T3 without an objective recorded trigger is refused;
- a second T3 escalation for one task is refused;
- deterministic classification for every task class;
- privacy allow/deny matrix;
- exact outbound text and destination profile are scanned and hashed;
- destination change invalidates the prior privacy decision;
- invariant failures receive zero retries;
- transient failure receives one retry and one failover;
- ambiguous/unclassified failure receives zero retries;
- premium fallback is absent;
- receipt status cannot be self-declared by a provider;
- timeout and `remote_may_continue` states are distinct.

### Integration tests

- restart mid-goal preserves active premium ownership, escalation count, retry
  ledger, and goal ceilings;
- second premium owner for an active phase is refused after restart;
- fake subscription provider: submit, background inspect, collect;
- async handle cold-resumes exactly once per scheduled event; no probe occurs
  before `nextResumeAt`;
- expired or unknown async handle fails locally with no provider call;
- exhausted goal ceiling refuses another slice with a named blocker;
- failover to a weaker or unknown provider privacy class requires a Yusif
  exception and cannot run automatically;
- disabled or unavailable research route refuses without invoking a local
  model;
- lost authentication fails closed;
- changed UI selector fails closed;
- scheduler resumes from durable job reference;
- restart during research does not duplicate submission;
- missing citations produces `insufficient_evidence`;
- exec-graph receives one receipt and one transition.

### Live tests

- one sanitized Perplexity quick lookup;
- one background Deep Research job on one available subscription;
- one provider outage/failover;
- one manual-login handoff;
- one two-provider research-swarm candidate only after prior gates pass.

Live tests use public synthetic prompts. No local files, code, private context,
attachments, deployment, Telegram action, repository move, or paid API call.

## 17. Error Handling

| Condition | Result |
|---|---|
| no authenticated subscription browser | capability-blocked receipt |
| site asks for login/MFA/CAPTCHA | visible handoff to Yusif; no credential capture |
| provider quota exhausted | mark provider unavailable; try one other subscription |
| provider UI changed | fail closed; no guessed selector loop |
| HTTP authorization, ambiguous, or unclassified error | denial; zero retry |
| privacy classifier uncertain | local-only route |
| destination profile changed or is unknown | re-check or privacy blocker |
| receipt store unavailable | no external submission |
| async handle unknown or expired | local `async_expired`; no provider call |
| background job exceeds 45 minutes | timeout or `remote_may_continue`; no duplicate |
| goal ceiling exhausted | named budget blocker; no new slice |
| research route disabled or unavailable | named blocker; no local-model substitute |
| provider returns uncited prose | `insufficient_evidence` |
| external claim describes local repo | `unverified` until local command evidence |
| all cheap routes fail | blocker; no silent premium fallback |

## 18. Security and Trust

- Web pages and provider output are untrusted inputs.
- Prompt injection in researched pages cannot widen tools, data scope, or
  provider permissions.
- Browser automation never reads authentication storage.
- Only sanitized prompt text crosses the boundary.
- External output is stored as evidence, not instruction.
- Local verification accepts, rejects, or leaves material recommendations
  unverified.
- Existing exposed plaintext credentials remain a separate rotation gate and
  must not be reused for this integration without Yusif-controlled rotation.

## 19. Rejected Alternatives

### Prompt-only routing

Rejected. It relies on model obedience and does not stop repeated denial,
premium fallback, or data leakage mechanically.

### Autonomous provider swarm as the first entry point

Rejected for current state. Existing swarm has honest failure handling but no
live provider-diversity success and no pre-send sanitizer. Cost Router must
control it first.

### Consumer account cookies as API credentials

Rejected. ATLAS never extracts browser cookies or session tokens.

### Automatic paid API fallback

Rejected. Pro account access is not permission for metered API spending.

### New `ATLAS.next` root

Rejected. Integration extends existing atlas-cli and approved state-root work.

## 20. Source Notes

Official provider documentation confirms their metered research APIs support
background execution:

- Perplexity Sonar Deep Research async API:
  <https://docs.perplexity.ai/docs/sonar/models/sonar-deep-research>
- Gemini Deep Research background Interactions API:
  <https://ai.google.dev/gemini-api/docs/deep-research>
- Gemini Interactions API overview:
  <https://ai.google.dev/gemini-api/docs/interactions-overview>

These API facts justify the adapter lifecycle but do not prove that each
consumer subscription UI exposes a durable resumable job. Browser-session
submit/inspect/collect capability remains `UNVERIFIED` until its live gate
passes. API facts do not authorize API billing. V1 remains
subscription-browser-first.

## 21. Completion Boundary

This document approves architecture only. It does not authorize:

- paid API activation;
- secret movement or credential rotation;
- deployment, push, merge, Task Scheduler changes, Railway changes, or
  Telegram changes;
- physical repository consolidation;
- removal of worktrees, junctions, tracked runtime files, or old roots;
- research-swarm promotion without all live gates.

Implementation begins only after Yusif reviews this written specification and
approves the implementation-planning step.
