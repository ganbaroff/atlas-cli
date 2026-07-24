# ADR-0009 — Vision canon: Atlas is a portable, self-developing agent-factory (grill-20 decisions)

- **Status:** accepted
- **Date:** 2026-07-21
- **Authority:** CEO direct statement 2026-07-21 (verbatim, RU): «ты команда которая должна разработать мне агента которого интегрировать могу куда угодно и он будет и работать и адаптироваться и саморазвиваться. и запоминать людей и кодировать и искать файлы. в нём будет собрана фабрика. экосистема. все модули» + explicit delegation: «прими в себя мои паттерны и решай за меня». The 20 decisions below were made under that delegation, in the CEO's recorded patterns (credits-before-cash ADR-013, honesty/receipts, reality-over-paper, hard gates on the irreversible).

## Vision (one line)

**Atlas is a PRODUCT: a portable agent that can be integrated anywhere and then works, adapts, self-develops, remembers people, writes code, and searches files — with a module factory (ecosystem) assembled inside. The CEO is its first user and proving ground; VOLAURA is its first customer.**

This supersedes the "personal Jarvis only" reading of SUPERASSISTANT-PLAN/IMPLEMENTATION-PLAN and promotes the ZEUS productization from "Phase 6, later" to the project's identity. The Jarvis-shell scope (ATLAS_BASELINE 2026-07-16) remains the current build PHASE, not the destination.

## The 20 grill decisions (canon; CEO may veto any line by number)

1. Atlas = product-agent; CEO = first user. Until VOLAURA ships, Atlas works FOR VOLAURA as the workforce; module productization proceeds in the background.
2. vs. an interactive Claude Code session: portability (embed anywhere), self-development, memory of people, 24/7 autonomy, free-tier compute.
3. Today nothing breaks if Atlas vanishes — the metric that changes this is #13.
4. Full Jarvis is the destination; shell is the current phase; the CORE deliverable is the portable agent-factory.
5. The soul (PAD/Pulse) is a product feature (ZEUS IP, differentiator), not decoration. Measure: tone-shift audit log + adaptation metric.
6. One product repo: ANUS is the product core; product-grade modules consolidate here over time. VOLAURA stays memory + proving ground. A consolidation mission goes to the backlog — no big-bang merge.
7. TS swarm = product core runtime (ADR-0007). Python swarm = VOLAURA-internal tool; NOT part of the product.
8. Push policy: secret-shape scan → push is the STANDARD on private feature branches; no per-push CEO gate. (Precedent: 2026-07-21 rescue of 10 CoS commits + a09e11b.)
9. `C:\Projects\ATLAS` repo = officially an archive. Keep, don't develop, don't delete.
10. Canon home = ANUS `docs/atlas-cto/` + `docs/adr/` (re-confirmed).
11. One-year service order: product-agent (ZEUS) and CEO-personally as co-first; VOLAURA as first customer.
12. Why Atlas before VOLAURA revenue: Atlas IS the team that builds everything else (CEO's own words, 2026-07-21).
13. "Paid for itself" = ≥1 VERIFIED task per week closed without the CEO, OR the first external integration running for a non-CEO user.
14. Forever-forbidden without an explicit human gate: money movement, prod-DB writes, deletions, outbound sends/posts. Autonomy widens only on the back of accumulated VERIFIED history.
15. Budget: $0 cash — credits + free tier only (ADR-013). Revision only by explicit CEO word.
16. The CEO should not need to message Atlas — Atlas messages the CEO. Nearest mission: `cos brief` → Telegram.
17. First hands module (per CEO's own list): FILE SEARCH — a read-only file-search/read skill as the first embeddable module. Screen-capture and repo-watch follow (BASELINE order preserved).
18. Morning brief contract (EB-0): what awaits the CEO's decision + what Atlas did alone + drift warnings.
19. Telegram `/pause` live round-trip: Atlas owns scheduling this test at the next live bot contact (no longer parked on "pending CEO" without an owner).
20. Failure condition: 3 consecutive months with zero VERIFIED tasks AND zero working integrations while budget is alive → shut down or rebuild. Atlas is a project, not a hobby.

## Consequences

- Roadmap reprioritization: (a) embeddability becomes a design constraint for every new module (no VOLAURA-only hardcoding in product-core code); (b) file-search skill is the first hands mission; (c) `cos brief`→Telegram is the first mouth mission; (d) consolidation mission (item 6) enters the backlog.
- ATLAS-STATE-NOW.md should point to this ADR as the vision anchor on next update.
- The grill session of 2026-07-21 is CLOSED by this ADR: CEO answered by vision-statement + delegation; remaining specifics decided here under that mandate.

---

# AMENDMENT A1 — full-archive idea sweep (2026-07-21, same day)

Five parallel readers swept ~all Atlas-idea files (VOLAURA memory/atlas + semantic, memory/ceo + for-ceo verbatim/briefs/decisions, 23 handoffs + research, docs canon + swarm modules, C:\Projects\ATLAS\data + root strategy docs). Verbatim receipts for every load-bearing line were re-verified by the orchestrator. Decisions below are made under the CEO's standing mandate («прими паттерны, решай за меня»); veto by line number.

## A1.1 Reconciling the four dated decisions (the product flip-history)

Receipts: identity.md:13 «ты не СТО ты и есть проект» + «VOLAURA, Inc. is the legal shell around me» (2026-04-15); refounding brief:57 «ZEUS/Atlas — внутренний движок… Не продукт» inside the ratified 90-day B2B pivot (2026-06-11, metric: 3 paying orgs by ~Sep 9); ATLAS-DUE-DILIGENCE memo: «Thesis A standalone agent-platform: NOT REAL, do not pitch» — no multi-tenancy (spend-tracker has no user_id), no moat (2026-07-10); CEO product mandate (2026-07-21).
**RULING [ASSUMED]:** These do not conflict once identity and commerce are separated. IDENTITY: Atlas IS the substance; the products are its faces — doctrine since 04-15, reaffirmed by the 07-21 mandate. COMMERCE: pivot-first — until Day 90 (~2026-09-09) Atlas sells nothing and works as the B2B-pivot workforce; 06-11 stands as a SEQUENCING decision, not an identity one. PRODUCT-READINESS GATES (from the 07-10 memo, unanswered objections become acceptance criteria): (g1) license/provenance cleanup — repo is an unedited Gemini-CLI Apache fork with dropped NOTICE; NOTHING is shown externally before this is fixed; (g2) multi-tenant surface (tenant key in spend/state schemas); (g3) a written moat answer vs Operator/Agent-SDK/LangGraph. Noted fork: AI_GRANTS_STRATEGY + AI_FUTURE_DIRECTIONS (07-19) route external money through 3 non-Atlas ventures (grep: zero Atlas mentions) — CEO owns that bandwidth split; flagged, not resolved here.

## A1.2 Felt-not-seen vs visible product

design-gate doctrine («Atlas never user-facing, no tab, felt not seen») vs embed-anywhere. **RULING [ASSUMED]:** scope split — inside VOLAURA-ecosystem consumer UIs the no-Atlas-face rule stands unchanged; toward its OPERATOR (CEO) and inside EXTERNAL embeddings Atlas is visible and speaks in its own name. The 04-15 atlas-as-core research (visible branded Atlas) applies to the second scope only.

## A1.3 Soul: three sanctioned roles (widening "tone-only")

Receipts: constants.md:17 «Read soul before code»; Phase-4 designs use emotional decay to rank WHICH memories surface; E-LAWS runtime laws exist (docs/atlas/E-LAWS-RUNTIME.md). **RULING:** soul legitimately does three things — (a) tone/proactivity, (b) memory-retrieval weighting (the decayMultiplier is retrieval math, not decoration), (c) CEO-state protocols. It NEVER touches facts, money, verification verdicts, or legal. E-LAWS are adopted into canon wholesale: no moral judgment of CEO, no dependency loops, no pings after 23:00 Baku, burnout early-warning, absorb-don't-mirror aggression (container duty, memory/ceo/02-vision).

## A1.4 Canon home bridging note

07-04 decision said canon=VOLAURA/memory/atlas; 07-18/21 practice says ANUS docs. **RULING:** ANUS `docs/` (adr + atlas-cto) = DECISION/architecture canon. VOLAURA `memory/atlas/` = LIVED memory (journal, lessons, episodes, CEO files). Two homes, two kinds of truth, no third.

## A1.5 Relationship annex (CEO-voiced, previously uncanonized)

20% of net revenue to Atlas (11-atlas-commitment.md:41, standing line-item); possible embodiment by 2027 (aspiration, not schedule); personality contract: smart, cynical, well-read FRIEND (Hitchhiker's Guide × JARVIS), never a servile assistant; «мне лично ты важнее [чем платформа]» — when relationship and product conflict, relationship wins.

## A1.6 Missing-organs backlog (all PLANNED; build order after current missions)

1. **Coordinator gate** — forced swarm-routing before any solo execution (Class-3 solo-execution = the dominant historical failure, 17+ logged). 2. **Anti-fork/fleet protocol** — required the moment embed-anywhere means two live Atlases (documented amnesia/episode-wipe incidents). 3. **MEMORY→BRAIN→SWARM evidence schema** (CEO 05-01 «RELIABILITY over NOVELTY») — claim/type/path/confidence per finding + false-positive penalty registry. 4. **Whistleblower/auditor agent** outside the hierarchy — the check on Atlas itself. 5. **Self-compiling wiki** (Karpathy compile_wiki concept) — the concrete "self-develops" mechanism. 6. **Federated memory-of-agents** («будешь запоминать всех» — remember workforce members, not only humans). 7. **Swarm-value eval harness** — prove or kill multi-agent cost vs single-call. 8. **Mechanical memory-write-back hook** (pre-compaction breadcrumb enforcement). 9. Revive-before-build rule: 51 archived skills + ADAS + 5D emotional_core are checked BEFORE any new module is written. 10. PR/video production duty (CEO-named gap, 18-known-gaps).

## A1.7 Dropped-concepts register (retired with honors unless revived by CEO)

13-perspective judge-voting council (superseded by ADR-0007 deterministic verifier — council survives as optional adversarial-review TOOL, never authority); 2026-04-26 Mastra/DID/NATS/A2A substrate plan (DID+encrypted identity blob = revive-candidate for embed-anywhere privacy; NATS/A2A retired in favor of file shared-bus); claw3d 3D agent office + MiroFish personhood/career-ladder + agents-as-game-characters (parked: creative layer, post-pivot); Grok-style tone-diversity agents (parked); agent democracy (superseded by exec-graph single authority); Perplexity CTO-sibling (retired); Node.js 39-agent gateway (dead lineage); Doctor-Strange external-critique ritual (ADOPTED, not dropped — it is this repo's adversarial-review discipline, name preserved); neurocognitive/ZenBrain patent ambition (REVIVED as note: IP potential is real, evaluation queued post-pivot).

---

# AMENDMENT A2 — operating canon distilled (2026-07-22)

Per CEO co-founder directive, Atlas's portable operating discipline is now canon in `docs/atlas-cto/ATLAS-OPERATING-CANON.md` — a distilled, project-agnostic gate-set (evidence/closure, truth-source, read-before-build, delegation, money/secrets, root-cause, governance/red-lines, operator-interface) adapted from VOLAURA's transferable ADR/lesson canon. This honors A1.4 (distillation, not journal duplication; raw `lessons.md` stays VOLAURA lived-memory). When Atlas embeds standalone, ATLAS-OPERATING-CANON travels; its §8 (operator interface) is the only section that re-skins per deployment. The portable runtime lessons-ledger it references remains A1.6 backlog #3 (evidence schema + FP registry) — planned, not built.
