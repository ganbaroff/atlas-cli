# ATLAS Research Swarm Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TypeScript research-swarm honest, bounded, and evidence-producing with structured artifacts and eval harness.

**Architecture:** New `src/research-swarm/` module; `swarm.ts` delegates to lifecycle orchestrator; CLI/python-bridge wired for fail-closed behavior.

**Tech Stack:** TypeScript, Vitest, existing Mastra agent + model-router

## Global Constraints

- No TRADER changes, no Telegram, no deploy/push/PR
- Max 2 live-smoke LLM runs during verification
- Never read/print `.env`
- Paid providers require `ATLAS_ALLOW_PAID=1`
- Commits as you go; branch `codex/atlas-swarm-reliability`
- Tests: `npm test -- --run` must stay green (726+ baseline)

---

### Task 1: Schema + types + artifact writer

**Files:**
- Create: `src/research-swarm/types.ts`, `src/research-swarm/model-family.ts`, `src/research-swarm/artifact.ts`
- Test: `src/__tests__/research-swarm/artifact.test.ts`

- [ ] Write failing tests for schema v1, status enum, secret scan
- [ ] Implement types + artifact builder + local write
- [ ] Commit

### Task 2: Provider routing interface

**Files:**
- Create: `src/research-swarm/provider-routing.ts`
- Modify: `src/agent.ts` (preferredProvider param)
- Test: `src/__tests__/research-swarm/provider-routing.test.ts`

- [ ] Test: worker route uses subtask provider without env mutation
- [ ] Implement routeWorkerProvider()
- [ ] Commit

### Task 3: Timeouts

**Files:**
- Create: `src/research-swarm/timeouts.ts`
- Test: `src/__tests__/research-swarm/timeouts.test.ts`

- [ ] Test routing/worker/judge/global timeout helpers
- [ ] Implement withTimeoutOutcome + readTimeoutMs
- [ ] Commit

### Task 4: Diversity + consensus gates

**Files:**
- Create: `src/research-swarm/diversity.ts`
- Test: `src/__tests__/research-swarm/diversity.test.ts`

- [ ] Test LIMITED_DIVERSITY (2+ providers), STRONG_CONSENSUS (3+ families), MULTIMODEL_UNAVAILABLE
- [ ] Implement evaluateDiversity()
- [ ] Commit

### Task 5: Honest synthesis

**Files:**
- Create: `src/research-swarm/synthesis.ts`
- Test: `src/__tests__/research-swarm/synthesis.test.ts`

- [ ] Test deduped claims passed to judge prompt, dissent included
- [ ] Implement buildSynthesisInput + runJudge()
- [ ] Commit

### Task 6: Memory degradation

**Files:**
- Create: `src/research-swarm/memory-state.ts`
- Test: `src/__tests__/research-swarm/memory-state.test.ts`

- [ ] Test Supabase 401 → DEGRADED_MEMORY
- [ ] Implement probeMemoryState()
- [ ] Commit

### Task 7: Lifecycle orchestrator

**Files:**
- Create: `src/research-swarm/lifecycle.ts`, `src/research-swarm/index.ts`
- Modify: `src/swarm.ts`
- Test: `src/__tests__/research-swarm/lifecycle.test.ts`

- [ ] Test all-timeout → TIMEOUT status, no SUCCESS
- [ ] Implement runResearchSwarm() with global bound
- [ ] Wire swarm.ts
- [ ] Commit

### Task 8: Python bridge fail-closed

**Files:**
- Modify: `src/atlas/python-bridge.ts`, `src/cli.ts` (swarm-deep)
- Test: extend `src/__tests__/python-bridge.test.ts`

- [ ] Test stale proposals rejected, no silent fallback flag
- [ ] Implement stdout protocol + EXPERIMENTAL_BRIDGE_DISABLED
- [ ] Commit

### Task 9: A/B eval harness

**Files:**
- Create: `src/research-swarm/eval-harness.ts`, `src/research-swarm/fixtures.ts`
- Modify: `src/cli.ts` (swarm-eval command)
- Test: `src/__tests__/research-swarm/eval-harness.test.ts`

- [ ] Deterministic fixture eval → KEEP_DISABLED verdict (current state)
- [ ] Commit

### Task 10: CLI exit codes + docs

**Files:**
- Modify: `src/cli.ts`, `src/atlas/swarm-logger.ts`
- Test: `src/__tests__/research-swarm/cli-exit.test.ts`

- [ ] Non-zero exit on TIMEOUT/PROVIDER_FAILURE
- [ ] Process exit test
- [ ] Commit

### Task 11: Verification + live smoke (max 2)

- [ ] `npm run build && npm run typecheck && npm test -- --run`
- [ ] Secret scan on artifact output
- [ ] 1-2 live smoke runs, verify exit + artifact
- [ ] Final commit
