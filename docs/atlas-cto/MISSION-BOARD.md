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
| P0 | Gate: $980 Azure ownership, 460 AZN debt, Google billing re-check, voice-ladder ruling, 2027-Q1 gate ruling | BLOCKED-CEO | CEO | all five CEO rulings recorded; no phase below starts before this closes | none yet | CEO decision on the 5 open items (key-rotation portion no longer blocks — see Standing Debts) |
| P1 | Hands safety + courier kill (runner safety envelope to standard; retire Cursor paste-relay) | QUEUED | ATLAS | autonomous change made/verified/rolled back with zero human paste; restart-durable spend cap; `/pause`+PANIC halt a live run; 0 human relays for one full mission; sandboxed change proven in an isolated Integronix worktree, prod untouched | none | P0 |
| P2 | Autonomy spine (`PlanContract` spec, `MISSION-BOARD.md`+`ORCHESTRATOR-STATE.md`, hard verification middleware, durable scheduled wake, memory-canon backup+restore) | QUEUED | ATLAS | one full goal→plan→execute→verify→board cycle with zero CEO actions, including one honest REJECT of a defect planted by a separate agent; restore-from-zero of memory canon demonstrated | none | P1; also blocked on M3→M4 cutover per §0 dependency (below) |
| P3 | First contract: Integronix (auth, D1 schema, admin, customer-facing AI agent) | QUEUED | ATLAS | Atlas runs the whole mission with CEO approving only milestones M1-M6; zero task-level CEO involvement; production untouched outside an approved milestone; rollback demonstrated before first production write; agent refuses out-of-licence claims in a red-team test | none | P2; inherits P2's board+verifier; also blocked on M3→M4 cutover; **first action still outstanding: CEO acceptance receipt for `C:\Projects\INTEGRONIX` as canon repo** (megaplan §4 P3) |
| P4 | Multi-project brain (name the per-repo lock primitive; run 2 more projects as customers) | QUEUED | ATLAS | two projects progressed in one night with a deliberate collision attempt correctly refused and logged; board is the CEO's single control surface; courier-actions/week = 0 | none | P3; also blocked on M3→M4 cutover |
| P5 | Voice daily organ (digest→TTS→Telegram voice note; STT questions back; free-first fallback ladder enforced in code) | QUEUED | ATLAS | CEO receives the voice report on 5 consecutive days AND the board shows every attempted day including failures, human-interaction counter 0 each day | none | P4 |
| P6 | Emotional memory live (decay-weighted retrieval on real content signal) | QUEUED | ATLAS | N≥10 pre-registered paired blind trials vs. a recency baseline, win threshold declared in advance, CEO genuinely blinded at judgment time | none | P5 |
| P7 | Mission gate 2027-Q1 (personal OS vs. sellable agent OS) — decision, not build | QUEUED | CEO | decision recorded; client site/orders proceed only after this gate | none | P6 |
| DESKTOP-SLICE-V0 | Windows Notepad read-only hands | VERIFY | ATLAS | 15/15 focused tests + sealed evidence + tamper REJECT, independently re-run by orchestrator | evidence pack `desktop-slice-v0-live-2026-08-06f` | awaiting CEO receipt |

---

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
| DEBT-4 | 460 AZN credited-pending (`atlas-debts-to-ceo.md`) | CEO closes | OPEN — **blocks P0** |
| DEBT-5 | Refresh stale `ATLAS-STATE-NOW.md` / `ATLAS-MASTER-PLAN.md` against 08-03..08-05 receipts | ATLAS | OPEN |
| DEBT-6 | Delete dead OpenManus path in `src/operator/action-lane.ts` (OpenManus rejected per `docs/REPO-ASSET-AUDIT.md`, not on disk) | ATLAS | OPEN |
| DEBT-7 | Push `C:\Projects\_backup\volaura-mirror-2026-06-28.git` branches to origin, then reclaim 5.7GB (100 of 115 branches exist nowhere else — never delete first) | CEO/ATLAS | OPEN |
| DEBT-8 | Fresh console check of Google billing `014883-4DBCC6-5D40F9` (data from 2026-06-10) | CEO-only | OPEN — **blocks P0** |
| P1-DEBT-01 | Lease-to-mutation binding: `RepoWriterLease` acquisition and the executor mutation gate were two separate calls with no re-check in between | ATLAS | CLOSED — `codex/p1b-spend-cap` commit `671a6cb` (`runExecutorGateMutation()` in `executor-gate.ts`, re-validates lease+expiry+owner+repo-path fresh from disk immediately adjacent to the mutation callback) |
| P1-DEBT-02 | Provider bypasses found during P1-B wave 1 spend-ledger work — direct paid provider calls that do not go through the spend gate: `src/atlas/telegram-capability.ts:89` (direct paid OpenAI Whisper fetch, ungated), `src/tools/surf.ts:227`, `src/atlas/emotion.ts:243`, `src/goal-runner/red-line.ts:292` | ATLAS | OPEN — out of allowed scope this wave |
| P1-DEBT-03 | Spend module (`atlas/spend/*`) not yet wired into the real call path (`model-router.ts` / `mastra-agent.ts`) — cap/override enforcement exists but nothing calls it yet | ATLAS | OPEN |
| P1-DEBT-04 | No automatic TTL detection of stale `RESERVED` spend records — a reservation whose provider call never resolves (crash, hang) stays counted against the cap until an operator manually calls `markPendingReconciliation`/`commit`/`release` | ATLAS | OPEN |

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
