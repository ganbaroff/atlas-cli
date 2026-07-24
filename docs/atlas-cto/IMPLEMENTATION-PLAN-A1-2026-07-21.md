# Implementation Plan — everything ADR-0009+A1 found (2026-07-21)

> Design-doc for the full realization of the vision canon + Amendment A1 sweep findings. Written to Google-design-review standard: every item has design, DoD, verification, size, risk. Companion to ADR-0009 (identity/decisions) — this is HOW, that is WHAT/WHY.
> Review status: DRAFT → adversarial panel (arch + pragmatism critics) → v2 → canon.

## 1. Context and goals

Atlas = portable self-developing agent-factory (ADR-0009). A1 sweep surfaced 10 missing organs, 3 product gates, E-LAWS/relationship duties, and 2 standing missions. This plan slots ALL of them into the existing verified spine instead of bolting on new systems.

**Existing spine (all shipped, tested 570/0):**
`exec-graph` (single task authority, 11-state, evidence-gated) → `hands/` (delegation registry + deterministic NO-LLM verifier) → `swarm-exec/` (bounded runtime, honest VERIFIED/REJECTED) → `model-router` (cost-ordered, anthropic excluded from WORKER) → `cos/` (read-only brief/drift projection) → policy.yaml + spend caps + panic.

**Goals:** implement every A1 item without breaking the spine's two invariants: (I1) only the deterministic verifier closes tasks; (I2) irreversible actions (money/prod-DB/delete/send) never execute without a human gate.
**Non-goals (this horizon):** embodiment, 3D office, voice TTS, NATS/A2A revival, VOLAURA-product work (separate chat), any cloud deploy without CEO gate.

## 2. Architecture rule for every new organ

Each organ enters as a **module with a manifest** (id, capabilities, permissions, tests, tone-vs-authority class). This manifest layer IS the "module factory": embed-anywhere later means shipping the registry + modules, not the whole repo. No organ may write exec-graph state directly (I1). No organ may bypass policy.yaml (I2).

## 3. Workstreams

### WS-0 — Reliability of the machine itself (builds trust in every later claim)
| Item | Design | DoD | Verify | Size |
|---|---|---|---|---|
| 0.1 Coordinator gate (organ 1) | NOT a new agent: middleware at task-execution entry — any execution without a routing decision record (swarm/hand/solo+justification) is refused; decision logged to run bundle. Merges poka-yoke C-10. | solo execution without recorded routing decision = structurally impossible in `atlas task run` paths | unit: refusal test; live: one task each route | M |
| 0.2 Evidence schema (organ 3) | extend verifier receipts to typed claims {claim,type,path,confidence,risk}; add FP-registry file: verifier-refuted claims append (hand,claim-type) → penalty visible in cos drift | every VERIFIED bundle carries typed claims; FP registry grows on refutes | schema tests + one deliberate false claim → penalty recorded | M |
| 0.3 Auditor/whistleblower (organ 4) | read-only scheduled hand (`local-readonly` class): replays last N run-bundles against policy.yaml + E-LAWS; violations → escalation file + Telegram ping. NO authority (reports only) — check-on-Atlas outside hierarchy | audit run produces report; seeded violation gets flagged | inject synthetic violation bundle → ping fires | M |
| 0.4 Eval harness (organ 7) | benchmark set (10 fixed tasks) × {single-call, swarm-3, swarm-5} × free providers; deterministic metrics (exit, latency, token cost) + LLM-judge quality score; output = numbers deciding swarm policy | one command produces comparison table; verdict recorded as ADR | rerun stability ±10%; judge blind to arm labels | M |
| 0.5 Write-back hook (organ 8) | pre-exit/pre-compaction hook enforcing breadcrumb line (mechanical, not discipline) | exit without write-back = blocked/warned loudly | kill-test: interrupt session, check breadcrumb | S |
| 0.6 Revive-before-build (organ 9) | inventory doc of 51 archived skills + ADAS + 5D core with verdicts (revive/retire); rule added to CLAUDE/ARCHITECTURE: check inventory before new module | inventory exists, referenced by rule | spot-check 5 inventory entries against files | S |

### WS-1 — Memory (the "self-develops" substrate)
| 1.1 Self-compiling wiki (organ 5) | `atlas wiki compile`: raw memory md → atomic concept notes + [[backlinks]] + staleness frontmatter into `state/wiki/`; recall reads wiki first | compile runs idempotently; concept count grows; recall cites wiki notes | golden-test: known fact retrievable via concept note | L |
| 1.2 Memory-of-agents (organ 6) | agent-profile records per hand: performance history, FP-penalties (ties to 0.2), specialization notes; cos brief can cite "which hand is trustworthy for X" | profiles auto-update after each verified run | run 3 tasks → profiles reflect outcomes | M |
| 1.3 Retrieval weighting (soul role b) | decayMultiplier ranks recall candidates (extends existing emotional-memory tables); tone never alters facts — weighting affects ORDER only | recall order changes with intensity; content identical | unit: same query, different intensities → order diff, set same | M |

### WS-2 — Soul (three sanctioned roles, A1.3)
| 2.1 E-LAWS enforcement | port E-LAWS-RUNTIME.md into policy: quiet-hours block in notify path (23:00–08:00 Baku, panic exempt), dependency-loop + moral-judgment bans as prompt-layer rules, burnout early-warning = PAD trend surfaced in brief | notify at 23:30 Baku = suppressed+queued; brief shows PAD trend | unit on notify gate + clock-mock tests | M |
| 2.2 Tone audit log | every tone-shift decision appended to audit file (spec IMPLEMENTATION-PLAN §3.5) | log exists, shifts traceable | seeded mood change → log entry | S |
| 2.3 Personality contract | system-prompt layer: cynical well-read friend (Hitchhiker×JARVIS), container-duty (absorb, never mirror aggression) — prompt+tests, no architecture | golden transcript tests pass | LLM-judge on 5 fixture dialogues | S |

### WS-3 — Mouth/autonomy (Atlas writes first)
| 3.1 cos brief→Telegram | daily scheduled send of `cos brief` (decisions-awaited + done + drift), quiet-hours aware (2.1), CEO-only allowlist unchanged | CEO receives morning brief without asking | live send receipt + /pause honored | M |
| 3.2 /pause round-trip | scheduled live test with CEO's one tap; result recorded | round-trip receipt in canon | live | S |

### WS-4 — Hands/factory (embed-anywhere concrete)
| 4.1 File-search module (CEO-named first) | read-only file-search/read skill AS THE FIRST MANIFEST MODULE (template for factory): glob+grep+rank over allowed roots, policy-scoped paths | `atlas find "query"` works; module has manifest+tests; zero write caps | golden queries on fixture tree | M |
| 4.2 Module manifest SDK | manifest schema (id, caps, permissions, tests, class) + loader; existing skills wrapped progressively | ≥2 modules loaded via manifests | schema validation tests | M |
| 4.3 OpenManus hand V1 | register openmanus in hand registry as GATED hand (foreground, evidence-gated via dispatcher); widening = its own mission per Hand-Contract doc | openmanus delegation runs one real browser task end-to-end VERIFIED | live smoke, human-watched | L |
| 4.4 Anti-fork protocol (organ 2) | instance-id + state lease (lockfile w/ heartbeat) + refusal to run second writer instance; courier SHA rules for cross-machine | two concurrent launches → second goes read-only with loud notice | spawn-two test | M |

### WS-5 — Product gates (pre-external; g1 early, g2-g3 post-pivot)
| 5.1 g1 License/provenance | replace fork LICENSE/NOTICE truthfully (Apache-2.0 obligations honored: NOTICE restored, provenance stated), README describes THIS repo | repo legally shippable | license-check + human read | S — DO EARLY |
| 5.2 g2 Multi-tenancy | tenant key in spend/state schemas + config isolation; design doc first (touches everything — needs its own review) | design doc approved, then phased migration | schema tests | L |
| 5.3 g3 Moat thesis | written doc: honest-verification + soul + federated memory + $0-cost-discipline vs Operator/LangGraph/SDKs; includes ZenBrain IP evaluation (patent note revived) | doc exists, adversarially reviewed | critic panel | M |
| 5.4 DID identity blob (revive-candidate) | design doc only this horizon (PBKDF2→AES-GCM personality blob, platform sees ciphertext) | design doc | review only | S |

## 4. Sequencing (pivot-first, A1.1 ruling)

**Phase P1 (now → Day 90 ≈ Sep 9) — serves the B2B pivot + zero-risk hygiene:**
3.1 brief→Telegram → 0.1 coordinator gate → 4.1 file-search module (+4.2 manifest skeleton) → 0.2 evidence schema → 5.1 license g1 → 0.4 eval harness → 0.5 hook, 2.1 E-LAWS, 2.2/2.3, 3.2, 0.6.
**Phase P2 (post-Day-90):** 1.1 wiki, 1.2 agent-profiles, 1.3 retrieval, 0.3 auditor, 4.3 openmanus, 4.4 anti-fork, 5.2 multi-tenant, 5.3 moat, 5.4 DID.
**Parked (CEO word only):** embodiment, 3D office/MiroFish, voice, NATS/A2A, grant-fork resolution.

## 5. Decision-verification framework (the CEO's «а реально ли решения правильные»)

Three built-in mechanisms, each producing NUMBERS or refutations, not vibes:
1. **Eval harness (0.4)** — proves/kills the swarm-cost decision and future module choices A/B. First target: is swarm-exec actually better than single-call for our task mix (books said 9.3 vs 9.7 AGAINST multi-agent — we test OUR mix, not books').
2. **Adversarial review ritual (Doctor-Strange, adopted in A1.7)** — every milestone's design gets an external-critic pass BEFORE build; every finished milestone gets a post-retrospective «was the path right or pivot?». This plan itself goes through the panel first (receipts appended below).
3. **Deterministic verification chain (I1) + FP-registry (0.2)** — "done" is machine-checked; hands that lie accumulate visible penalties; auditor (0.3) checks the checker.

## 6. Risks (top 5, honest)

R1: P1 overload — 11 items in ~7 weeks alongside pivot work; mitigation: strict order, S/M items only in P1 except 4.1. R2: wiki (1.1) scope explosion — timebox, MVP = compile+backlinks only. R3: OpenManus live smoke touches real browser — human-watched only, GATED hand class. R4: multi-tenancy retrofit cost — design-doc gate before any code. R5: quiet-hours/notify changes could silence real alarms — panic path explicitly exempt, tested.

## 7. Review receipts (three independent reviews, 2026-07-21)

- **Architecture critic (Opus, code-grounded, 27 tool uses): APPROVE-WITH-CHANGES, 2 blockers.** (a) I1 already violated in code: `atlas task move <id> verified` closes solo tasks without the verifier — api.ts:213-222 gates only `hand:`-owned; (b) coordinator gate aimed at nonexistent `atlas task run`; real chokepoint = `moveTask()` api.ts:206. Majors: I2 is a read-model not enforcement (real floor = shell/fs/notify gates); notify has 3 independent Telegram paths (repo-watch.ts:128, telegram.ts:769/846); receipt schema unversioned → replay break; manifest SDK duplicates handSpec ~80%; 4.1-before-4.2 order wrong; E-LAWS-as-prose can't be deterministically audited; no observability/rollback/state-versioning.
- **Pragmatism critic (Sonnet, 36 tool uses): APPROVE-WITH-CHANGES.** 3.1 morning brief ALREADY LIVE (`scheduleMorningBriefing` telegram.ts:853-883, on Railway) — hidden real blocker = CEO-gated manual redeploy for new content; 0.4 eval = L smuggled as M (needs provider reliability that doesn't exist); 4.3 OpenManus unrealistic this quarter (no DAYTONA key anywhere, `C:\Projects\OpenManus` deleted from disk, prior smoke full of 429s); P1 overscoped ~11 items/7 weeks solo; almost nothing in P1 serves the 3-paying-orgs pivot metric.
- **Atlas's own swarm (live run, `atlas swarm`, 5 perspectives): HONEST FAILURE = behavioral review.** 0/5 workers (all nvidia, 504 Gateway Timeout ×5, 60s timeout each); Atlas honestly reported inability instead of fabricating — ADR-0007 honesty mechanism proven live AGAIN. The run surfaced 3 NEW real bugs: (b1) spend tracking writes to nonexistent table `public.llm_spend` (Supabase 404 PGRST205) — **money discipline silently broken**; (b2) emotional-memory recall Supabase 400 PGRST100 «failed to parse filter (5)» — malformed query in brain-planner path; (b3) all 5 workers pinned to nvidia with no per-worker failover on timeout despite router fallback design. Run log: `memory/atlas/swarm-runs/2026-07-21T16-31-45.json`.

## 8. v2 REVISIONS (BINDING — override conflicting v1 lines)

**R-1 (new P0, before everything): FIX I1.** Verifier-verdict requirement moves into `moveTask()` for ALL owners; `--evidence` auto-promotion may not satisfy the verified-transition alone. The coordinator gate (0.1) is REDEFINED as this same moveTask middleware (routing decision + verifier verdict), not a new layer. Size M. This is the trust foundation; nothing else in WS-0 counts until it lands.
**R-2: I2 redefined.** «All irreversible effects route through the shell/fs/notify gates» — enforced as hand capability classes, policy.yaml stays the declarative read-model. Direct `fetch`/`fs`/raw-send in any organ = review-blocking violation.
**R-3: notify consolidation precedes quiet-hours.** Single `telegramSend` chokepoint first (fold repo-watch and telegram.ts direct sends into notify), THEN one panic-exempt time gate. E-LAWS land as CODED predicates (auditable), prompt-prose only for tone rules.
**R-4: receipts get `receiptVersion` + additive-only typed-claim fields + replay-old-bundles test.** No breaking schema change on the append-only ledger.
**R-5: no second module system.** Manifest = EXTENSION of handSpec (add `tests`, `toneClass`); file-search registers as a `local-readonly`-class HandSpec. 4.2-schema-extension lands BEFORE 4.1.
**R-6: P1 RESCOPED to 7 items** (pragmatist top-5 + R-1 + live-run bugs): 1) R-1 I1-fix; 2) b1 spend-table fix + b2 recall-filter fix (money+memory truth); 3) 5.1 license/provenance; 4) 0.5 write-back hook; 5) 3.2 /pause round-trip; 6) 3.1 cos-brief **CLI-scope only** (Railway boot-wiring = explicitly CEO-gated deploy, named as such); 7) 0.6 revive-inventory. Everything else leaves P1.
**R-7: 0.4 split.** 0.4a harness code (P2, S); 0.4b live A/B — PRECONDITIONED on b3 failover fix + a provider-health check passing 3 consecutive days. No A/B before that; the live swarm failure is the receipt for why.
**R-8: marked ASPIRATIONAL (not planned):** 5.2 multi-tenancy (until an external-customer signal exists), 5.4 DID blob, 0.3 auditor + 1.2 agent-profiles (fleet-of-one today), 4.3 OpenManus (revisit when DAYTONA/env question is CEO-decided).
**R-9: observability mini-block added to P2 head:** counters for verifier rejects / notify suppressions / gate refusals; feature-flag on moveTask+notify hot-path changes; `schemaVersion` + GC policy for every new state store.
**R-10: decision-verification framework (§5) unchanged in principle, but its первый numbered proof-point becomes the live-run of 2026-07-21:** the machinery already refused to fake success — the honesty chain is real; what's broken is provider reliability and spend accounting, and P1 now fixes exactly those.


---

# 2026-07-22 · STATE RECONCILIATION + DESIGN-LANE SPRINT (atlas-cto-design)

**The binding execution plan is NOT this file.** It is the M1-M10 mission map in `VOLAURA/memory/atlas/codex-loop.md` (Rounds 6-23), owned by `fable-orchestrator` (sequence/tokens), `codex-verifier` (PASS/REFUTE), `terminal-atlas-executor` (code). This section is the `atlas-cto-design` VIEW: reconcile reality, slot my design-lane specs, hand the CEO his gate-list. NO verdicts here (Codex is sole verifier).

## A. Reality 2026-07-22 (receipts: ground-truth reader, this session)
- ANUS HEAD `e6a317a` (feat/arsenal-wiring), clean, == origin. Suite: **620 passed / 2 skipped, exit clean** (Git Bash run).
- Gate A `TRUST-FLOOR-01` `c47a2ea`: REFUTE -> rework -> **PASS** (Codex R9). I1 now UNCONDITIONAL (`api.ts:206-211` throws for ALL owners; `_viaVerifier` removed; promotion only via `src/exec-graph/verifier-port.ts`) — stronger than this plan's R-1 proposed.
- Gate B `BROWSER-HAND-01` `b21228b` + Gate C `GOAL-RUNNER-01` `0983154`: **PASS-WITH-EXCEPTION** (Fable self-verified). Standing debt: independent Git-Bash audit through the codex-verifier SEAT. This session's green suite run satisfies it as a FACT, not through that seat — the protocol step is still owed.
- Frozen mission map (codex-loop R23): M1 done, M2 done(debt), M3 done(debt) -> **M7 pending token** -> M4 -> M6 -> M5 -> M8 -> M9 -> M10-internal.

## B. This plan's P1 (§8 R-6) reconciled — done/open
1. I1-fix -> **DONE** (`c47a2ea`+`0983154`). 2a. spend-table live apply -> **OPEN** (CEO gate). 2b. recall filter -> **DONE**. 3. license/provenance -> **OPEN**. 4. write-back hook -> **OPEN**. 5. /pause round-trip -> **OPEN** (folded into M7). 6. cos-brief CLI -> **DONE**. 7. revive-inventory -> **OPEN**.

## C. Design-lane sprint — atlas-cto-design deliverables (spec-only; executor builds; codex verifies)
Sequenced to land WHERE the mission needs them, never parallel to the M-map.
- **D1 — Evidence-schema + auditor spec (feeds M8).** ANUS spec for A1.6 #3 (typed claims `claim/type/path/confidence` + false-positive penalty registry) + #4 (read-only auditor hand, no authority). DONE-bar: spec doc in `docs/atlas-cto/` with interfaces + machine-checkable test criteria; executor builds in M8; codex verifies. Owner (spec): me. Can start now — blocks nothing.
- **D2 — Portable lessons-ledger spec (A1.6 #3 runtime half).** The mechanism a standalone-embedded Atlas uses to record its OWN new lessons (ties to `ATLAS-OPERATING-CANON.md` §Lessons-ledger). DONE-bar: spec of append-only local ledger + schema; distinct from VOLAURA lived-memory per A1.4. Owner (spec): me.
- **D3 — Canon-sync duty (standing, per-milestone).** As M4-M10 land, reflect shipped reality into ADR-0009 / ATLAS-STATE-NOW so canon never lags code (Class-58). Owner: me.

## D. CEO gate-list — the taps only you can make (work minimized to a checklist)
1. **Spend live-DB apply** — money-truth broken since 07-21; migration ready (`ANUS/db/migrations/llm_spend.sql`), needs apply to live Supabase. One decision.
2. **M7 trigger** — after fable-orchestrator countersigns the R23 draft: your single trigger (includes `claude update` approval) -> executor spawns. Unblocks /pause + notify chokepoint.
3. **Vercel billing** — VOLAURA frontend frozen; `/az/login` still a placeholder (primary market cannot log in). Business action.
4. **Hub71 / Sanabil portal registrations** — standing external ask (Gate C business fallback 2026-07-24 23:00 Baku).
5. **Three forks awaiting YOUR ruling** (flagged this session, no verdict from you yet): (a) grant-money via 3 non-Atlas ventures vs Atlas-as-fundable; (b) my `[ASSUMED]` rulings in ADR-0009 A1 (product-but-pivot-first) — stand until you veto by number; (c) felt-not-seen (internal UI) vs visible-product (external embeds), A1.2 `[ASSUMED]`.

## E. Frozen / what dies (sprint-contract)
Nothing new starts outside the codex-loop M-map. Embodiment / 3D-office / voice / NATS stay parked (ADR-0009 A1.7). This section adds ONLY design specs D1-D3 + the CEO surface; it creates no competing execution track.

Provenance: reconciled from codex-loop Rounds 6-23 + live suite run + IMPLEMENTATION-PLAN-A1 / ADR-0009 via ground-truth reader receipts, 2026-07-22, atlas-cto-design.
