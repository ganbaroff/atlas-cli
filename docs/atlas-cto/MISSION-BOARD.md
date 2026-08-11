# MISSION-BOARD

Single control surface for Atlas-as-contractor work. Purpose: the CEO approves
MILESTONES only; tasks and subtasks live inside a milestone and are the
executor's business — the CEO never has to read task-level detail here.

States: `QUEUED` / `RUNNING` / `VERIFY` / `DONE` / `BLOCKED-CEO`. Rule: **no
`DONE` row without a receipt link.** A row with a receipt-shaped claim but no
link is not DONE — it stays `VERIFY`.

---

## MILESTONE TABLE

Phases P0..P7 from `C:\Projects\ATLAS-MEGAPLAN-2026-08-05.md` §4 (merge
candidate, not yet merged into this table's parent plan — see Dependency
note below). Strictly sequential: a phase starts only when the previous
phase's DoD closes.

| id | title | state | owner | DoD (one line) | receipt | blocked-by |
|---|---|---|---|---|---|---|
| P0 | Money gate: $980 Azure ownership, Google billing re-check, voice-ladder ruling, 2027-Q1 gate ruling | BLOCKED-CEO | CEO | the four CEO rulings recorded | none yet | CEO decision on the 4 open items. **This phase no longer blocks technical work** — see CEO ruling 2026-08-07 below. |
| P1 | Hands safety + courier kill (runner safety envelope to standard; retire Cursor paste-relay) | RUNNING | ATLAS | autonomous change made/verified/rolled back with zero human paste; restart-durable spend cap; `/pause`+PANIC halt a live run; 0 human relays for one full mission; sandboxed change proven in an isolated Integronix worktree, prod untouched | P1-A wave 1 `45b303e` (18/18) + wave 2 `ad5153f` (40/40 focused twice, full suite +22 pass / 0 new fail, tsc 0 new errors) on `codex/p1a-work-orders`, unpushed; handoff `docs/atlas-cto/CURSOR-HANDOFF.md` | nothing — unblocked 2026-08-07 |
| P2 | Autonomy spine (`PlanContract` spec, `MISSION-BOARD.md`+`ORCHESTRATOR-STATE.md`, hard verification middleware, durable scheduled wake, memory-canon backup+restore) | QUEUED | ATLAS | one full goal→plan→execute→verify→board cycle with zero CEO actions, including one honest REJECT of a defect planted by a separate agent; restore-from-zero of memory canon demonstrated | none | P1; also blocked on M3→M4 cutover per §0 dependency (below) |
| P3 | First contract: Integronix (auth, D1 schema, admin, customer-facing AI agent) | QUEUED | ATLAS | Atlas runs the whole mission with CEO approving only milestones M1-M6; zero task-level CEO involvement; production untouched outside an approved milestone; rollback demonstrated before first production write; agent refuses out-of-licence claims in a red-team test | none | P2; inherits P2's board+verifier; also blocked on M3→M4 cutover; **first action still outstanding: CEO acceptance receipt for `C:\Projects\INTEGRONIX` as canon repo** (megaplan §4 P3) |
| P4 | Multi-project brain (name the per-repo lock primitive; run 2 more projects as customers) | QUEUED | ATLAS | two projects progressed in one night with a deliberate collision attempt correctly refused and logged; board is the CEO's single control surface; courier-actions/week = 0 | none | P3; also blocked on M3→M4 cutover |
| P5 | Voice daily organ (digest→TTS→Telegram voice note; STT questions back; free-first fallback ladder enforced in code) | QUEUED | ATLAS | CEO receives the voice report on 5 consecutive days AND the board shows every attempted day including failures, human-interaction counter 0 each day | none | P4 |
| P6 | Emotional memory live (decay-weighted retrieval on real content signal) | QUEUED | ATLAS | N≥10 pre-registered paired blind trials vs. a recency baseline, win threshold declared in advance, CEO genuinely blinded at judgment time | none | P5 |
| P7 | Mission gate 2027-Q1 (personal OS vs. sellable agent OS) — decision, not build | QUEUED | CEO | decision recorded; client site/orders proceed only after this gate | none | P6 |
| DESKTOP-SLICE-V0 | Windows Notepad read-only hands | VERIFY | ATLAS | 15/15 focused tests + sealed evidence + tamper REJECT, independently re-run by orchestrator | **Claude read-only audit 2026-08-07: 15/15 re-run green (exit 0) on `codex/desktop-slice-v0` @ `2eb4868`; 20 files / +2322 lines; receipt `...-06f` `verdict.status=VERIFIED`, `rawCoordinatesEnabled=false`, cleanup `closed=true` on owned pid only, no secret values; tamper fixture differs solely at `lineRead.firstLine="TAMPERED"` with `evidenceHash` unchanged — a correct fail-closed input; negative packs `-06c` (`first_line_mismatch`) and `-06d` (`tts_adapter_failure`) prove honest REJECT** | **NOT the CEO's receipt — one acceptance item is genuinely open: all five live packs have `transcript.source="typed"` and `audioHash=null`. The spec's live proof requires a real spoken command with no CEO paste. Both adapters are up (`127.0.0.1:8765` and `:8766` → HTTP 200 on 2026-08-07), so closing it needs one spoken run, nothing more.** |
| M-2026-08-10-01 | Hermes M1C — config-only live migration to schema v33 | DONE | Codex SOL (executed) / Fable (independently re-verified) | `C:\Projects\ATLAS\data\HERMES-M1C-CONFIG-ONLY-LIVE-MIGRATION-CARD-2026-08-10.md` | `C:\Projects\ATLAS\data\HERMES-M1C-CONFIG-ONLY-LIVE-MIGRATION-RECEIPT-2026-08-10.md` | state entered 2026-08-10 |
| M-2026-08-10-02 | AtlasLocalWatchdog re-enabled (was Disabled, local automation not running) | DONE | CEO (executed) / Fable (verified) | task Status=Ready with a future Next Run Time; CLAUDE.md's "live automation" description is accurate again | `memory/atlas/decisions/ATLAS-DECISION-2026-08-10-watchdog-re-enabled.md` — schtasks query after enable: Status=Ready, Next Run=8/10/2026 9:30:00 PM | state entered 2026-08-10 |
| M-2026-08-10-03 | Hermes M1D — Windows T1 isolation assessment | DONE | Fable (Opus seat) | verdict NOT_READY: no isolated identity, no secret/ACL boundary, unrestricted egress, self-writable policy, no Atlas proxy, no action broker | `C:\Projects\ATLAS\data\HERMES-M1D-T1-WINDOWS-ISOLATION-CARD-2026-08-10.md` | state entered 2026-08-10 |
| M-2026-08-10-04 | Hermes C5A + C5A-V + C5A-R1 — Atlas model broker, audited and remediated | DONE | Fable (built, audited, remediated) | broker enforces loopback-only upstream, authorization before forwarding, redirect/expiry/request-id all fail closed; 28/28 tests, live P1-P4 proof, redirect target 0 hits | `C:\Projects\ATLAS\data\HERMES-C5A-R1-SECURITY-REMEDIATION-RECEIPT-2026-08-10.md` | state entered 2026-08-10 |
| M-2026-08-11-01 | C5A work committed (was 8 files living only in a working tree) | DONE | Fable | broker + tests + integration proof are in git history, not just on disk | ANUS `80cec2a` on `codex/atlas-cost-router-design` (unpushed); ATLAS `a8f887d` carries the M1 arc receipts, migrator scripts and the `data/archive/2026-06/` move | state entered 2026-08-11 |
| M-2026-08-11-02 | Hermes C5B — Windows identity, ACL deny, egress containment, immutable config | QUEUED | ATLAS (design) + CEO (elevated shell, **one paste**) | the six M1D T1 checks pass live: read of a secret-bearing path denied, direct provider connection blocked, broker request logged, broker down → connection refused, config write denied, denied toolset structurally unavailable | none | C5A-2 and the first chat come first per the external CTO ruling `C:\Projects\ATLAS\data\KIMI-K3-CTO-CONSULT-NEXT-STEP-RESULT-2026-08-11.md` |
| M-2026-08-11-03 | External CTO ruling on the first-chat fork | DONE | Kimi K3 (ruling) / CEO (relayed) / Fable (locally corrected) | gate moved from "first dangerous toolset" to **"first capability beyond pure text chat, memory included"**; text-only chat has no technical escape path; symmetric key and self-editable denylist are latent, not active, while Hermes has no hands | `C:\Projects\ATLAS\data\KIMI-K3-CTO-CONSULT-NEXT-STEP-RESULT-2026-08-11.md` | state entered 2026-08-11 |
| M-2026-08-11-04 | C5A-2 — loopback egress leg (the component that makes a real first chat possible) | BUILT-AWAITING-CLOSURE | Fable (built) / Codex (independent closure) | 34/34 egress tests, 62/62 with the C5A suite, tsc clean for the module, and `scripts/c5a2-chain-proof.ts` **5/5 over real loopback sockets** — authorized call end to end, expired authority denied before any egress, 302 fails closed with redirect target at 0 hits, cap refuses the 4th call, egress down = connection refused with no fallback | ANUS `e552789`; `C:\Projects\ATLAS\data\HERMES-C5A2-EGRESS-LEG-RECEIPT-2026-08-11.md` | **audit scope, stated by the builder:** no real provider call has ever been made — every outbound call is an injected `fetchImpl`. Also open: Hermes not yet repointed off `https://openrouter.ai/api/v1` |
| DEBT-11 | `model-egress/spend-cap.ts` reimplements spend limiting in-process and never consults the existing `src/atlas/spend-policy.ts`, so it ignores the daily cap and the CEO pause file — a "stop" would not stop it | ATLAS | OPEN — found 2026-08-11 during the C5B0 prior-art search. Removes one of the arguments for keeping a custom egress layer; feeds M-2026-08-11-06 |
| DEBT-10 | Broker receipts cannot express the upstream class truthfully once the upstream stops being a local mock. Exact sites and type shape are in the Atlas-side receipt, not on this public board | ATLAS | OPEN — external CTO ruled 2026-08-11 this is **not deferrable debt**: it makes evidence materially false and blocks C5A-2 ACCEPT. Folded into the C5A-2-R1 scope |
| M-2026-08-11-05 | C5A-2-R1 remediation — narrow, pre-scoped, **not started** | QUEUED | ATLAS (build) / Codex (closure) | the five items named in the private remediation card, and no more. No new architecture, no scope growth | none | waits on the formal Codex verdict on `e552789`. **CEO challenge 2026-08-11, unresolved: should R1 be built at all?** Most of its scope is commodity gateway behaviour, and `ATLAS-OSS-RECONCILIATION-2026-08-08.md` §10 already ruled custom model routing should be replaced. See M-2026-08-11-06. After R1 (or its cancellation) the critical path returns to **C5B0 auth-carrier proof**. Defect detail is deliberately not on this board — this repository is public; it lives in the Atlas-side receipt |
| M-2026-08-11-07 | C5B0 auth-carrier preflight — can Hermes carry Atlas authorization without being able to issue it? | INTEGRATION_GAP | Fable (read-only) / external CTO (ruling) | header carrier PASS on the main conversation path. **Hermes must never hold Atlas signing authority** — ruled permanent, not a phase gate: a process that can sign can mint its own authorization, so ACLs cannot both hide the key and let it sign. Gap found: the per-call seam exists on one path only, while auxiliary tasks each hold their own endpoint configuration and no interception point — so the carrier must be a bounded session capability with broker-side derivation | `C:\Projects\ATLAS\data\HERMES-C5B0-AUTH-CARRIER-PREFLIGHT-2026-08-11.md` (file:line detail kept off this public board) | state entered 2026-08-11. Next: design the session capability. **No plugin, no key movement, no config change.** C5B OS boundary NOT ready to start |
| M-2026-08-11-09 | Auxiliary fallback chain is a fail-OPEN bypass | NEEDS-CTO-RULING | Fable (read-only finding) | all auxiliary tasks share one router whose documented step 1 is the main provider — so repointing the main endpoint covers them — but steps 2-6 fall through to other backends on their own separate authentication. A broker denial reads as a failed step 1, so refusing a call would route it around Atlas instead of stopping it | `C:\Projects\ATLAS\data\HERMES-C5B0-SESSION-CAPABILITY-DESIGN-2026-08-11.md` addendum | blocks C5B0 — a carrier that can be routed around is decoration. Open: whether pinning the task provider disables the chain, or the block must be structural at the OS boundary |
| M-2026-08-11-08 | C5B0 carrier design — bounded session capability, **design only** | NEEDS-CTO-RULING | Fable (design) / external CTO (ruling) | Atlas mints an opaque session handle it stores broker-side; Hermes holds only that handle plus a correlation id and can neither mint nor widen authority; the broker derives and signs each call server-side and enforces spend through the **existing** `spend-policy.ts`. Consequence worth the ruling: the carrier is a **config value, not a plugin**, so it also covers the auxiliary paths that have no interception seam | `C:\Projects\ATLAS\data\HERMES-C5B0-SESSION-CAPABILITY-DESIGN-2026-08-11.md` | design only — nothing built. Hard prerequisite, unverified: every auxiliary endpoint must honour a broker override, or one surface is a full bypass |
| M-2026-08-11-06 | Build-vs-buy ruling on the egress leg — does a stock LLM gateway replace C5A-2? | NEEDS-CTO-RULING | CEO challenge → external CTO | one ruling: keep the hand-written egress leg and fix it (R1), or run LiteLLM/Bifrost on loopback as the broker's approved upstream and delete C5A-2's provider-facing half. Done when the ruling is recorded and the board reflects it | none | **evidence:** LiteLLM issues virtual keys so the real provider secret never leaves the proxy — the exact goal of C5A-2 — plus per-key budgets, timeouts, streaming and retries as tested code. Counter-evidence already on file: `ATLAS-OSS-RECONCILIATION-2026-08-08.md` §11.2 records a **March 2026 LiteLLM supply-chain attack (v1.82.7-8) and two April CVEs**; Bifrost (Go, single binary) avoids the Python + Postgres operational tail. Atlas-specific signed-work-order authority (C5A) stays either way |

---

## CEO RULING 2026-08-07 — money gates do not block engineering

CEO verbatim: **«не должен блокировать твоя работа атлас а не долг. что за
хуйню придумал ты блокируешь сам себя»**, and, on the technical-authority
question: he confirmed he has never prohibited technical work. Standing grants
found in the memory canon and re-affirmed:
`auto-memory-snapshot-2026-04-17/handoff_prompt_for_other_chats.md:24`
(«CEO решает ТОЛЬКО стратегию … Не спрашивай CEO»),
`archive/DEBT-MAP-2026-04-15.md:896` («работать итерациями … Меня не
спрашивайте»), `ATLAS/data/HANDOFF-GPT-CTO-2026-08-06.md:13` («это твоя
работа»), ADR-0011 («перо твоё, начинай»).

Effect on this board:

1. **DEBT-4 (460 AZN) is removed from P0's blocking set.** It may block new
   paid spend; it does not block code, tests, local commits, or phase start.
2. **P0 no longer gates P1-P7 for technical work.** P0's remaining items are
   money/strategy rulings. A phase whose DoD needs new spend still waits; a
   phase that needs only engineering does not.
3. The `MISSION-BOARD.md` file is a **manual mirror, not an authority** — on
   any disagreement with the exec-graph ledger, the ledger wins. Making the
   board a generated read-only projection of the ledger is a P2 deliverable
   (external review #3 BLOCKER 5), gated on M3D→M4 because the ledger is not
   yet durable in cloud.
4. Atlas's own self-imposed constraint set is under external review:
   `C:\Projects\ATLAS-SELF-IMPOSED-CONSTRAINTS-REVIEW-REQUEST-2026-08-07.md`
   (ids S1-S18). Constraints proven self-imposed and unjustified are to be
   deleted, not re-litigated.

## STANDING DEBTS

From `ATLAS-MEGAPLAN-2026-08-05.md` §7. Debts 1-2 and the rotation component
of debt 3 are **CEO-WAIVED as of 2026-08-05** («ключи ротировать не буду.
всё ок.» — risk accepted, keys stay classified COMPROMISED). This shrinks
P0's blocking scope to the non-key items: the $980 Azure ownership question
(inside debt 3), debt 4 (460 AZN), and the Google billing re-check (debt 8).

| id | one line | owner | state |
|---|---|---|---|
| DEBT-1 | Rotate 22 keys exposed via `апи.txt` 2026-08-05 (OpenAI, Clerk, Vercel x2, Cloudflare x3, Turso x2, ElevenLabs, Fish, Kling, Pexels, Coverr, Upstash, Telegram bots) | CEO-only | WAIVED-BY-CEO 2026-08-05 |
| DEBT-2 | Supabase `sbp_` token hardcoded in `VOLAURA/.mcp.json` | CEO-only | WAIVED-BY-CEO 2026-08-05 |
| DEBT-3 | 4 older leaked keys (`for-ceo/tasks/2026-07-19-resource-control-sh2.md`) + the $980 Azure ownership question | CEO-only | rotation component WAIVED-BY-CEO 2026-08-05; **$980 Azure ownership question OPEN — blocks P0** |
| DEBT-4 | 460 AZN credited-pending (`atlas-debts-to-ceo.md`) | CEO closes | OPEN — **no longer blocks P0 or any phase** (CEO ruling 2026-08-07); may block new paid spend only |
| DEBT-5 | Refresh stale `ATLAS-STATE-NOW.md` / `ATLAS-MASTER-PLAN.md` against 08-03..08-05 receipts | ATLAS | OPEN |
| DEBT-6 | Delete dead OpenManus path in `src/operator/action-lane.ts` (OpenManus rejected per `docs/REPO-ASSET-AUDIT.md`, not on disk) | ATLAS | OPEN |
| DEBT-7 | Push `C:\Projects\_backup\volaura-mirror-2026-06-28.git` branches to origin, then reclaim 5.7GB (100 of 115 branches exist nowhere else — never delete first) | CEO/ATLAS | OPEN |
| DEBT-8 | Fresh console check of Google billing `014883-4DBCC6-5D40F9` (data from 2026-06-10) | CEO-only | OPEN — **blocks P0** |
| DEBT-9 | ANUS could not be installed from its own lockfile: `npm ci` fails ERESOLVE — `ollama-ai-provider@1.2.0` pins `zod@^3.25.76`, tree carries `zod@4.3.6` via `@ai-sdk/anthropic@3.0.71` | ATLAS | **CLEARED 2026-08-11** — `npm ci --legacy-peer-deps --no-audit --no-fund` installs 454 packages exit 0, lockfile untouched; C5A suite then re-ran **28/28 green from a clean install** (vitest 2.1.9, 5.26s). Underlying zod conflict still unresolved — use that exact command until `ollama-ai-provider` is dropped or bumped |

---

## KNOWN REALITY (2026-08-05 jarvis audit snapshot)

- Full suite: **1485 pass / 6 fail / 12 skipped** via `node node_modules/vitest/vitest.mjs run` — **not** `npx vitest`, which returns nothing on this host.
- Canon docs `ATLAS-STATE-NOW.md` + `ATLAS-MASTER-PLAN.md` are ~6 days stale and exist as **6 divergent copies** across worktrees.
- **15 worktrees** registered on this repo; 2 are prunable.
- Repo writer seat: standing ritual is CEO paste-relay into Cursor via `CURSOR-HANDOFF.md` each session — this is exactly the courier burden P1(b) targets for retirement.

---

## DEPENDENCY NOTE

`ATLAS-MASTER-PLAN.md`'s real in-flight milestone is **M3 Shadow
Consolidation** — M3C **VERIFIED** (preserved-state rehearsal, manifest
SHA-256 `432984c3...`), M3D **PACKET WRITTEN / IMPLEMENTATION NEXT** (cutover
readiness; slices 1-10 done, `pause-control`/`runner-log` remain external
writers handled at cutover). The plan's own gate: *"rehearsal against a
preserved copy of real state, then activation under the CEO's conditional
permission of 2026-07-31"* — flowing into the **"Yusif cutover gate"** before
M4 One Atlas cutover. `ATLAS-MASTER-PLAN.md` line 32 states plainly:
**"Physical consolidation is NO-GO. Live provider traffic has not started."**

Megaplan §0 names the consequence: P2, P3, and P4 above assume a single
durable, redeploy-surviving state authority. Today exec-graph ledger,
operator/control-plane state, budgets/leases, evidence ledger, and swarm-exec
bundles are **non-durable in cloud** — they reset on redeploy. P2/P3/P4 may be
*designed and specified* now but must not run live against unconsolidated
state until M3D→M4 closes. **Physical consolidation of this repo's own
worktrees is itself NO-GO** — do not attempt it as a side effect of any
milestone above.

---

## КАК ЧИТАТЬ ЭТУ ДОСКУ

Это единственная доска задач Атласа. `QUEUED` — в очереди, ещё не начато.
`RUNNING` — сейчас в работе. `VERIFY` — сделано, но чек ещё не подтверждён
независимо. `DONE` — подтверждено распиской (без неё DONE не считается).
`BLOCKED-CEO` — стоит, ждёт твоего решения, без тебя дальше не пойдёт. Ты
управляешь только на уровне вехи (milestone) — что внутри вехи (P1, P2 и
так далее), решает исполнитель сам. Если строка `BLOCKED-CEO` — значит
работа физически не может продолжиться, пока ты не ответишь.

---

Single source of task truth. Do not create a second board.
