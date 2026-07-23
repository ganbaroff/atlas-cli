# ATLAS — STATE NOW (post-compaction orientation)
_Last written: 2026-07-23 ~05:00 Baku by atlas-cto-design (canon-sync duty D3,
IMPLEMENTATION-PLAN-A1 §C). Previous version (2026-07-19, Chief-of-Staff V1
close-out) is superseded; its content is preserved in git history. Read this
FIRST on resume._

## PURPOSE (current mission)
**APP-RUN-01** — the multi-body mission turning Atlas into a working, verified
product-agent (ADR-0009: portable agent-factory). The binding execution plan is
the **M-module map in `C:\Projects\VOLAURA\memory\atlas\codex-loop.md`**
(Rounds 6-23) — NOT any single doc in this repo. Body registry (Round 5):
`fable-orchestrator` (sequence/tokens) · `codex-cto/verifier` (briefs, sole
final auditor) · `terminal-atlas-executor` (single code writer, FABLE.GO token
required) · `atlas-cto-design` (ANUS canon authority, advisory, no execution
tokens, no verdicts).

## MODULE MAP STATE (frozen Round 20; receipts Round 22)
- **M1 Trust Floor — CLOSED** `c47a2ea` (I1 unconditional: promotion only via
  `src/exec-graph/verifier-port.ts`; `_viaVerifier` removed).
- **M2 Browser Hand — CLOSED** `b21228b` (audit debt: independent Git-Bash
  reproduction through the codex seat).
- **M3 Goal Runner — CLOSED** `0983154` (Round 22 PASS-WITH-EXCEPTION; same
  Git-Bash audit debt). Effect-based red-lines, persisted budgets, single
  active lease, `atlas goal run` CLI.
- **NEXT: M7** Control+Notify+Supervised-Assist — Round 23 brief DRAFTED by
  codex, awaiting fable-orchestrator countersignature + single CEO trigger
  (which batches the one-time `claude update` approval). Then M4 → M6 → M5 →
  M8 → M9 → M10-internal.
- **⚠ BASELINE DRIFT — M7 token must be amended before spawn.** The R23 brief
  pins `parent 0983154...; tree clean`. HEAD has since moved by DOCS-ONLY
  commits (canon/specs by atlas-cto-design): `e6a317a`, `69b861f`, and this
  session's spec/state commits. No production/test file touched — verify with
  `git diff 0983154..HEAD --stat` (docs/ only). The executor's first command
  per the brief would otherwise STOP on baseline mismatch. fable-orchestrator:
  re-pin the token baseline to current HEAD after checking that diff.

## CANON (decision/architecture — this repo, per ADR-0009 A1.4)
- `docs/adr/0009-vision-canon-portable-agent-factory.md` — vision + grill-20 +
  A1 (flip-history reconciled, E-LAWS, missing-organs backlog A1.6, dropped
  concepts A1.7) + A2 (operating-canon pointer).
- `docs/atlas-cto/ATLAS-OPERATING-CANON.md` — portable discipline gate-set
  (travels with every embedding; §8 re-skins per deployment).
- `docs/atlas-cto/IMPLEMENTATION-PLAN-A1-2026-07-21.md` — plan v2 + the
  2026-07-22 STATE RECONCILIATION + DESIGN-LANE SPRINT section (D1/D2/D3).
- **Design-lane specs (landed 2026-07-23, spec-only, executor builds):**
  - `docs/atlas-cto/SPEC-M8-EVIDENCE-AUDIT.md` — D1: typed-claim evidence
    ledger + read-only auditor for M8 (A1.6 #3+#4).
  - `docs/atlas-cto/SPEC-PORTABLE-LESSONS-LEDGER.md` — D2: embedded-Atlas
    runtime lessons mechanism (A1.6 #3 runtime half).
- VOLAURA `memory/atlas/` = lived memory (journal codex-loop.md, lessons.md).
  Two homes, no third.

## VERIFIED THIS SESSION (2026-07-23, receipts in session log)
- HEAD `69b861f` == origin/feat/arsenal-wiring, tree clean.
- `npx tsc --noEmit` → 0 errors. `npx vitest run` → **77 files, 620 passed /
  0 failed / 2 skipped**. `npm run build` → clean.
- `graph status`: 1 verified · 2 rejected · 6 closed · 1 escalated (MIRT →
  owner volaura-product-chat — do NOT reopen here). `state/` untouched by all
  read commands.
- Model-router: anthropic structurally excluded from WORKER role
  (`src/model-router.ts` roles `['JUDGE','CRITICAL']`); paid openai/openrouter
  WORKER fallback exists but is gated by `enforceSpendPolicy()` at call sites.
  The old "WORKER calls leak to anthropic/cerebras" note is STALE — cerebras
  is not in the registry at all.

## OPEN / WHO OWNS WHAT
1. **M7 countersign + token** — fable-orchestrator (plus baseline re-pin, see
   drift warning above). CEO: single trigger incl. `claude update`.
2. **Git-Bash audit debt (M2+M3)** — codex-verifier seat.
3. **b1 spend-table live apply** — CEO gate (`db/migrations/llm_spend.sql` →
   live Supabase). Money-truth (`spend-tracker.ts` → `llm_spend`) broken until.
4. **License/provenance NOTICE** (plan §8 R-6 item 3, ADR-0009 A1.1 g1) — OPEN,
   executor task, pre-external-release blocker.
5. **Swarm live e2e VERIFIED** — still blocked by free-provider availability
   (env, not code; ADR-0007). CEO standing order: do not chase providers, no
   key changes. Honest REJECTED is the correct outcome until then.
6. **Heartbeat stale since 2026-06-26** — known problem #7, no assigned writer;
   `cos drift` correctly reports it every run (expected, not a bug).

## VERIFY COMMANDS (what "works" means)
```
cd "C:\Users\user\OneDrive\Documents\GitHub\ANUS"
npx tsc --noEmit                 # 0 errors
npx vitest run                   # 620 passed / 0 failed / 2 skipped (77 files)
npm run build                    # clean
node dist/cli.js graph status    # live exec-graph snapshot
node dist/cli.js cos brief       # Chief-of-Staff brief (read-only)
git status --porcelain state/    # EMPTY — no module wrote graph/state
```

## PROTOCOLS IN FORCE
- FABLE.GO token protocol: terminal-atlas-executor writes code ONLY under a
  countersigned token; single writer, WIP=1; six-field return to codex-loop.
- atlas-cto-design (this seat when resuming here): canon/specs/docs only;
  advisory entries in codex-loop with body header; NO verdicts, NO tokens.
- Every completion claim needs a same-turn tool receipt; CEO-verified turns
  end with «Что проверено / Что НЕ проверено».
- Push policy (ADR-0009 decision 8): secret-shape scan → push is STANDARD on
  private feature branches; no per-push CEO gate.
- Worktree protocol for VOLAURA memory writes when its tree is busy; codex-loop
  appends = own-body header only, never edit another body's entry.

## THE 12 KNOWN PROBLEMS (unchanged, ranked; detail in EXTERNAL-CTO-STATE-SNAPSHOT.md)
Structural: (1) VOLAURA canon memory fragmented across branches; (2)
memory/shared-bus gitignored = zero durability; (3) cloud bot runs with
different near-empty memory. Debt: (4) operator/ never runs; (5) 2 extra
memory systems, live use UNKNOWN; (6) dead getToolDict + no MCP client; (7)
heartbeat stale. Capability: (8) autonomy/hands LOCAL-only; (9) legacy task
authorities not retired; (10) no commitment-capture surface; (11) local/cloud
config drift. Governance: (12) concurrent same-repo writers (mitigated by the
body registry + single-writer token since Round 5); + carried security debt
(leaked keys, CEO-deferred rotation).

## HOW TO RESUME
1. Read this file, then the codex-loop tail (last ~3 rounds) for mission state.
2. `node dist/cli.js graph status` + `cos brief` for live state.
3. Identify which BODY you are (registry Round 5) — do not take another body's
   authority. Design/canon → this seat. Code → only with a FABLE.GO token.
4. Do NOT touch VOLAURA product; do NOT deploy/rotate keys/apply live DB
   without a CEO gate; do NOT reopen the MIRT escalated task.
