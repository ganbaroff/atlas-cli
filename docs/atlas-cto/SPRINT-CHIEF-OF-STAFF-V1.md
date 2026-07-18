# Compound Sprint — Chief-of-Staff Surface V1

_Owner: Atlas (External CTO), self-approved 2026-07-18. Scope: ANUS repo only. No deploy, no keys, no VOLAURA product. North Star: ATLAS = Chief-of-Staff / CTO operating system._

## PLAN

**Capability unlocked for CEO:** ATLAS truthfully tells him — DERIVED from the real authorities (exec-graph graph, control-plane, git, heartbeat, spend), never hand-fed — (a) what's **waiting on his decision**, (b) what **shipped**, (c) what's **drifting/rotting**, (d) **overdue obligations**. This replaces the manual morning brief (`briefing.ts::composeMorningBriefing` takes a hand-typed `awaitingCeo` string → it can lie/drift), extending the honest-status ethos to the Chief-of-Staff surface itself.

**Ground truth (verified this session):** graph = 1 verified/2 rejected/6 closed/1 escalated. Surfaces today: `status-report.ts` (/status: health/spend/queue/heartbeat), `exec-graph/brief.ts::formatStatusMessage` (graph section bolted onto Telegram /status), `briefing.ts` (08:45 brief, MANUAL input). None derive the decision picture from authorities. ADRs 0001–0007 fix the authority model; this sprint adds a **read-model/projection**, not a new authority.

**Authority-safety (non-negotiable):** the CoS surface READS authorities and writes nothing to state — it is a projection, NOT a second brain/task-authority/memory-authority/queue/router/notifier. The existing notifier SENDS; CoS only COMPOSES. The ONE additive change (W5: optional `dueAt` on the existing exec-graph Goal) extends the ONE authority (exec-graph), ADR'd — it is not a parallel store.

## WAVES (each: Sonnet hand DO → Opus CHECK: integration + receipts + regressions → commit)
- **W1 — CoS facts read-model** (`src/atlas/cos/facts.ts`): pure `gatherCosFacts(providers?)` → `{waiting, shipped, counts, controlMode, spend, generatedAt}` from exec-graph `statusSummary`/`listTasks` + control-plane mode + spend. Injectable providers; no writes. Tests.
- **W2 — Drift detectors** (`src/atlas/cos/drift.ts`): pure `detectDrift(inputs)` → `DriftFinding[]` for git remote≠local (unpushed), stale heartbeat (>N h), stuck tasks (non-terminal, oldest transition > N h), `graph verify` not ok. Injectable inputs. Tests. (Catches reality-vs-record drift — the 12-problem items.)
- **W3 — CoS brief composer** (`src/atlas/cos/brief.ts`): compose facts+drift into a truthful Russian voice-brief (decision-framed: жду решения / отгружено / дрейф / spend). Deterministic. Tests.
- **W4 — CLI + wire-in** (`atlas cos brief`, `atlas cos drift`): operator/local surface; a real local run showing a truthful brief from the REAL graph (runtime proof). Document how the 08:45 brief becomes graph-derived.
- **W5 — Obligation due-dates** (additive to exec-graph Goal): optional `dueAt` on `goalSchema` + `atlas goal add --due`; overdue open goals surface as "просрочено / жду решения". ADR-0008. Tests.
- **W6 — Docs + review**: ADR-0008 (CoS = read-model/projection; obligations = additive on exec-graph), update `morning-brief-and-status` runbook + architecture map + state/evidence index. Independent adversarial review + cold-reader.

## GATES
GREEN: isolated `src/atlas/cos/*` modules, local tests, local CLI runtime proof, scoped commits/pushes to `feat/arsenal-wiring`, docs/ADR.
RED (stop + escalate): deploy/prod mutation, credentials/keys, paid budget, irreversible change, security incident, VOLAURA product intrusion, authority duplication, real strategic contradiction.

## DoD (PLAN→DO→ACT→CHECK→COMPARE→LEARN→RESULT)
typecheck + full suite green (baseline 506/0/2, no regressions) · each new module unit-tested · `atlas cos brief`/`drift` produce truthful output from the real graph (runtime receipt) · docs+ADR-0008+runbook updated · adversarial + cold-reader pass · statuses honest (IMPLEMENTED-LOCAL vs LOCAL-VERIFIED distinguished). No second authority created.
