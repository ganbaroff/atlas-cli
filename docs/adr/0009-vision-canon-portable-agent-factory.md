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
