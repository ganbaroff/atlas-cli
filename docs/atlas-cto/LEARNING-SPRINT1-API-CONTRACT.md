# Learning Sprint 1 — API Contract (VOLAURA ↔ Atlas)

Status: **IMPLEMENTED** (local file exchange + in-process port)  
Branch: `feat/learning-sprint1`  
Modules: `src/learning/*`

## Architecture boundary

```text
VOLAURA = learner, course, mastery (source of truth)
Atlas   = NBA decision, exec-graph goal, evidence ledger, FinOps receipt
```

Atlas receives a **mastery snapshot** per request. It does **not** store or mutate canonical mastery.

## Transport (Sprint 1 — pilot only)

File exchange via `ATLAS_LEARNING_EXCHANGE_DIR`:

```text
{exchange}/requests/{requestId}.json   ← VOLAURA writes
{exchange}/receipts/{idempotencyKey}.json  ← Atlas writes (idempotent)
```

CLI drain: `atlas learning drain`

**Not for production.** Sprint 2+ should move to HTTP/gRPC adapter.

## Envelope fields (all requests)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `schemaVersion` | `"1.0"` | yes | contract version |
| `requestId` | string | yes | unique per delivery attempt |
| `idempotencyKey` | string | yes | stable across safe retries |
| `createdAt` | ISO datetime | yes | request creation time |
| `issuedBy` | string | yes | e.g. `volaura` |
| `kind` | `decide\|outcome` | yes | |

Receipts echo `schemaVersion`, `requestId`, `idempotencyKey`, `createdAt`. Successful decide receipts also include `decisionId`.

## 1. Decide — next best learning action

### Request (`kind: "decide"`)

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_sigmoid_001",
  "idempotencyKey": "idem_learner123_sigmoid_session1",
  "createdAt": "2026-07-25T12:00:00.000Z",
  "issuedBy": "volaura",
  "kind": "decide",
  "payload": {
    "learnerId": "123",
    "concept": "sigmoid",
    "mastery": 0.35,
    "lastAnswers": [false, true, false],
    "responseTimeSec": 28,
    "energy": "medium"
  }
}
```

### Response receipt (`status: "completed"`)

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_sigmoid_001",
  "idempotencyKey": "idem_learner123_sigmoid_session1",
  "createdAt": "2026-07-25T12:00:00.000Z",
  "decisionId": "dec_abc123",
  "correlationId": "req_sigmoid_001",
  "status": "completed",
  "updatedAt": "2026-07-25T12:00:01.000Z",
  "kind": "decide",
  "goalId": "gol_abc123",
  "decision": {
    "decisionId": "dec_abc123",
    "action": "VISUAL_EXPLANATION",
    "difficulty": "BEGINNER",
    "reason": "Повторяющаяся ошибка в понимании вероятности",
    "decisionScore": 0.78,
    "alternatives": ["GRILL_ME", "FLASHCARDS"],
    "requiresHumanReview": false
  },
  "spendCorrelationId": "uuid",
  "evidenceClaimId": "clm_..."
}
```

`decisionScore` is a **rule-based weighted score**, not a statistical probability.

### Decision actions

`VISUAL_EXPLANATION` | `TEXT_EXPLANATION` | `FLASHCARDS` | `GRILL_ME` | `PRACTICE_QUIZ` | `SCHEMA_DIAGRAM` | `AUDIO_EXPLANATION`

### Side effects (Atlas)

1. `exec-graph` goal: `NBA: {concept} → {action}` (`source.kind = volaura-work-queue`)
2. `evidence ledger` narrative claim (`kind: learning-nba-decision`)
3. `spend-tracker` local receipt (`caller: learning-nba`, 0 tokens — algorithmic, no LLM in final decision)

## 2. Outcome — learner result after lesson

### Request (`kind: "outcome"`)

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_outcome_001",
  "idempotencyKey": "idem_outcome_learner123_sigmoid_session1",
  "createdAt": "2026-07-25T12:05:00.000Z",
  "issuedBy": "volaura",
  "kind": "outcome",
  "payload": {
    "learnerId": "123",
    "concept": "sigmoid",
    "decisionCorrelationId": "idem_learner123_sigmoid_session1",
    "completed": true,
    "correct": true,
    "responseTimeSec": 15,
    "selfReportedConfidence": 0.7
  }
}
```

## Idempotency & crash safety

| Scenario | Behavior |
|----------|----------|
| Same `idempotencyKey`, new `requestId` | Returns existing completed receipt — **no second decision** |
| Invalid JSON / schema | `LearningRequestParseError` with readable `details` |
| Crash before receipt write | No receipt at `{idempotencyKey}` — **safe retry** |
| Explicit processing failure | Failed audit receipt at `failed:{requestId}` — does not block retry |

## Failure matrix

| Condition | Receipt status |
|-----------|----------------|
| Success | `completed` |
| Duplicate in same process (in-flight) | `duplicate` |
| `ATLAS_READONLY=1` | `readonly` |
| Internal error | `failed` (retryable via same idempotencyKey) |

## Scoring rule (Sprint 1)

- **LLM**: optional candidate hints only (`candidate-generator.ts`)
- **Final score**: transparent weighted sum in `nba-engine.ts` → exposed as `decisionScore`
- **Human review**: `review-policy.ts`

Sigmoid fixture → **decisionScore 0.78**.

## Optional Supabase mirror (NOT APPLIED)

`db/migrations/002_learning_decisions.sql` — CEO-gated DDL. Local ledger remains authoritative.

## Tests

`src/__tests__/learning-sprint1.test.ts` — sigmoid fixture, idempotency, invalid JSON, crash retry, full cycle.
