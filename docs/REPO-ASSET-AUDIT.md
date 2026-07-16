# Atlas — Repo Asset Audit

> Author: Atlas (Local CTO lane) · Date: 2026-07-16 · READ-ONLY audit. No repo was
> modified, nothing built/installed/deployed/pushed. No secret values read/printed —
> credential **locations** only (per locked CEO decision: keys are not this sprint).
> Purpose: find the best EXISTING components to integrate into Atlas — not rebuild.

## 1. Executive verdict

- The two "flagship" local candidates — **caveman-inspect** and **godmode-inspect** — are **public third-party skill/prompt packs, not agent frameworks and not Jarvis brains.** Neither adds a Jarvis *capability* (voice, hands, vision).
- Their real, proven value is **token economy + engineering discipline**: caveman's **~65% output compression** (incl. a `caveman-shrink` MCP proxy) and godmode's **measure→keep-or-revert optimize loop + failure-memory**.
- **openclaw-office** is a fill-in-the-blank persona/soul template (no git, frozen) → do **not** adopt (would create a second memory/persona source, which is forbidden).
- The genuinely **missing** Jarvis capabilities (voice STT/TTS, camera, email/Google, real "hands") are **missing everywhere locally** — no cloned repo provides them. **OpenManus** (the intended hands) is **not on disk**.
- **ZEUS**: only the **emotion engine is real and already wired into ANUS**; the "39-agent gateway" is frozen paper with no source.
- Net: adopt **narrow modules** (caveman-shrink MCP, deterministic compressor) and **reference** godmode's patterns. Do not import any framework wholesale. Atlas cloud stays the brain; ANUS stays control; VOLAURA stays memory.

## 2. Candidate inventory

| Repo | Path | Runs? | Relevant capabilities | Health | Recommendation |
|---|---|---|---|---|---|
| **caveman-inspect** | `…\GitHub\caveman-inspect` | **Yes** (Node, tests 31/32) | token compression, skill bundle, `caveman-shrink` MCP proxy, Windows scripts | clean; remote `github.com/JuliusBrussee/caveman` (public MIT) | **EXTRACT MODULE** |
| **godmode-inspect** | `…\GitHub\godmode-inspect` | validator PASS 744/0; numeric benches **stall on Windows (WSL-gated)** | markdown skill pack, optimize-loop, failure-memory, design-level orchestration | clean; remote `github.com/arbazkhan971/godmode` (public) | **EXTRACT/REFERENCE** (patterns) |
| **openclaw-office** | `…\GitHub\openclaw-office` | n/a (markdown scaffold) | persona/soul/council template; TTS/camera as config placeholders | **no git**, frozen | **REFERENCE ONLY / REJECT** |
| **VOLAURA/.octogent** | `C:\Projects\VOLAURA\.octogent` | in-proc state dir | multi-agent "tentacles" orchestration **state** (not a framework) | working state | already part of Atlas — not a separable asset |
| **OpenManus** ("hands") | `C:\Projects\OpenManus` | **ABSENT** | intended sandboxed agent hands | not cloned; needs `DAYTONA_API_KEY` | **DEFER/REJECT** (needs checkout + cred) |
| **ZEUS** | (no repo on disk) | emotion **live in ANUS**; gateway = paper | emotion/pulse (real), 39-agent gateway (frozen) | mixed | emotion **already adopted**; gateway **REJECT** |
| **Hermes** | installed app; **no local repo** | unknown | (installed desktop app, provenance unclear) | no repo asset | investigate later; not an integrable repo |
| **ANUS** | `…\GitHub\ANUS` | **Live** (this is the Atlas CLI) | the control surface itself | live | **KEEP** — it *is* Atlas |

## 3. Capability matrix vs current Atlas

| Capability | Verdict | Notes |
|---|---|---|
| Voice STT | **MISSING (regressed)** | Atlas had Whisper but its OpenAI key is dead; no repo provides free STT |
| Voice TTS | **MISSING EVERYWHERE** | openclaw references TTS as a *config placeholder* only; no impl anywhere |
| Desktop tray / local UI | **ALREADY IN ATLAS** | Phase 2 tray |
| Screen vision | **ALREADY IN ATLAS** | Phase 3 `screen_capture` (AV-gated) |
| Camera vision | **MISSING EVERYWHERE** | openclaw config placeholder only |
| Browser / computer-use | **ALREADY IN ATLAS** | `surf.ts` + session MCP (chrome/computer-use) |
| Shell / app-launch | **ALREADY IN ATLAS** | governed `shell.ts` + policy whitelist |
| Email / Google / calendar | **MISSING** | godmode's `email` skill is for *building* SMTP into an app, not sending |
| Persistent memory | **ALREADY IN ATLAS** | VOLAURA + Supabase. godmode's repo-local file memory = **DUPLICATE, do not integrate** |
| Agent orchestration / swarm | **ALREADY IN ATLAS** | operator dispatcher + VOLAURA python swarm + `.octogent`. godmode design-level = duplicate |
| Skills / plugin system | **BETTER IN CANDIDATES (as catalogs)** | caveman (6 skills) + godmode (134 skills) are richer skill *libraries* to mine — but as content, not runtime |
| MCP support | **BETTER IN CANDIDATE** | caveman `caveman-shrink` = an MCP token-compressor Atlas lacks |
| Telegram / chat | **ALREADY IN ATLAS** | Telegraf, CEO-auth |
| Autonomous scheduling / notify | **PARTIAL IN ATLAS** | cron/briefing/repo_watch exist; **brain-loop is inert** (see §Candor) |
| Policy / permissions / audit / cost | **ALREADY IN ATLAS (better)** | Phase 1 `policy.yaml`; both candidates have **no runtime guardrails** |
| Windows compat | Atlas ✅ · caveman ✅ · **godmode ✗ (WSL)** | godmode installers need WSL/POSIX symlinks |
| Cloud vs local split | **ALREADY IN ATLAS** | candidates are local-only skill packs |

**Punchline:** the candidates are token-economy + skill-library assets. They add **no new Jarvis capability**. The real capability gaps (voice, camera, email, hands) are unfilled by any local repo.

## 4. CAVEMAN deep-dive

- **What it is:** the public **`caveman` installer** (`caveman-installer` v0.1.0, MIT, JuliusBrussee) — a cross-agent **skill bundle**, *not* an agent. Drops a "talk like caveman" skill into 34 host agents; headline = **~65% output-token reduction** (range 22–87%, honest 3-arm eval: baseline / "answer concisely" / skill). A separate `caveman-code` terminal agent exists **only as a README link — not cloned**.
- **Runs:** yes — pure Node (zero runtime deps), `bin/install.js --help/--list` work, deterministic compressor smoke works (preserves code/URLs/paths), `npm test` → **31/32** (the 1 fail is a Windows `\` vs `/` path assertion). Windows scripts present (`install.ps1`, statusline `.ps1`).
- **Reusable modules (this is the value):**
  1. **`src/mcp-servers/caveman-shrink/`** — a stdio MCP proxy that compresses the `description` fields in `tools/list`. Directly attacks Atlas's biggest recurring cost: huge deferred MCP toolsets loaded every turn.
  2. **`caveman-shrink/compress.js`** — a deterministic (no-LLM) prose compressor that **byte-preserves** code/URLs/paths/identifiers. Reusable to shrink Atlas's oversized `CLAUDE.md`/memory files (the file itself says "prune, don't shout").
  3. Safety layer worth copying: `is_sensitive_path` (refuses to send secret files to the API) + "Auto-Clarity" (auto-disables compression on security/irreversible steps) — matches Atlas's non-negotiables.
- **Already partly adopted:** a `caveman` skill is **already in Atlas's global skill list** — so the voice-compression capability is effectively live; only the MCP proxy + file compressor are un-extracted.
- **Disposition: EXTRACT MODULE** (caveman-shrink MCP + compress.js). MIT-licensed, public, no cred, Windows-OK.

## 5. Jarvis CLI / ready-agent deep-dive

- **There is no ignored "ready Jarvis CLI" sitting on disk.** ANUS **is** the Jarvis CLI (live on Railway). The two "-inspect" repos are **skill/prompt packs for coding agents**, not standalone Jarvis assistants.
- **godmode-inspect:** public `@godmode/claude-code-plugin` (arbazkhan971) — 134 markdown skills + 7 subagents + hooks + per-CLI install adapters; **Bash+Markdown, no runtime binary.** Its headline "measure→modify→verify→keep-or-revert (git-as-memory)" loop is real IP.
  - **Phase A/B are self-optimizations of godmode's own harness, not product features:** Phase A = **skill-routing** (prompt→markdown-skill match) 67%→100% on a 102-prompt eval; Phase B = Tier-1 frontmatter token trim −18.5%. **"Routing" ≠ LLM-provider routing** — godmode has none; it does not compete with ANUS `model-router.ts`.
  - Runs: structure validator PASS 744/0; numeric benches **stall on Windows/msys** (need WSL). Capabilities: nearly all absent (no voice/vision/hands/telegram/runtime-policy); memory + orchestration are repo-local/design-level → duplicates of Atlas.
  - **Disposition: EXTRACT/REFERENCE** the optimize-loop + failure-memory taxonomy + progressive-disclosure token discipline. Do **not** run/import it (Windows-hostile, capability-empty).
- **Count of real ready-agent candidates: 0** (both are packs; ANUS remains the agent). Best "agent-adjacent" asset = caveman's compression modules.

## 6. Integration architecture — stays Atlas vs adopt

**Stays Atlas (do not replace/duplicate):** cloud brain (Railway `volaurabot`), ANUS control surface + `model-router.ts` (provider routing/failover), VOLAURA memory + Supabase (single memory source), operator dispatcher + python swarm (orchestration), `policy.yaml` + pause + token gates + Telegram CEO-auth (guardrails), the ZenBrain emotion engine.

**Adopt (narrow extraction only):**
- caveman **`caveman-shrink` MCP proxy** → sits at the MCP layer, compresses tool-list descriptions before they hit context.
- caveman **deterministic `compress.js`** → a `atlas compress` utility / pre-commit for oversized memory docs.

**Reference (mine patterns, write no import):**
- godmode **keep/discard optimize-loop** (mechanical metric gate + discard-audit) → informs Atlas's `evaluator.ts`/`operator`.
- godmode **failure-memory taxonomy** (8 failure types → `lessons.md`, reflect on 3+ fails) → aligns with Atlas's stuck-loop rule.

**Reject:** openclaw-office (2nd memory/persona — forbidden), godmode wholesale (Windows-hostile, no capability), OpenManus (absent + needs cred), ZEUS gateway (paper), Hermes (no repo).

## 7. Ranked plan

- **P0 — highest leverage, smallest safe:** EXTRACT caveman **`caveman-shrink` MCP proxy** and wire Atlas's deferred/loaded MCP tool descriptions through it.
  - Benefit: cuts recurring per-turn token cost (the deferred MCP toolset is large every session). Seam: an MCP middleware in front of the session/registry tool list. Size: **S–M**. Windows ✅ / cloud N/A (a local/dev-loop optimizer). Risk to live bot: **none** (does not touch the Railway bot). Cred/budget/CEO: **none** (public MIT).
- **P1 — next:** EXTRACT caveman **`compress.js`** as `atlas compress <file>` to shrink oversized `CLAUDE.md`/memory docs; add the `is_sensitive_path` refusal. Size **S**. No cred. Then REFERENCE godmode's optimize-loop + failure-memory into `evaluator.ts` (design task, **M**).
- **Reject/defer:** godmode wholesale · openclaw-office · OpenManus (until CEO wants real hands + Daytona) · ZEUS gateway · Hermes (until its provenance is worth a look).

**Note (honest):** none of these repos moves Atlas toward the *missing* Jarvis capabilities (voice/camera/email/hands). If the goal is "more Jarvis," the leverage is **not** in these packs — it's in fixing voice STT (dead) and deciding on hands (OpenManus), both of which need a CEO call (§9).

## 8. Evidence receipts (no secrets)

- Enumeration: `ls …\GitHub` → {ANUS, blogsite, brandedby, caveman-inspect, godmode-inspect, openclaw-office}; bounded `find -maxdepth 2 -iname` for jarvis/hermes/zeus/manus/octogent → only `.octogent` (in VOLAURA), the three GitHub repos.
- caveman: `git -C … remote -v` → `github.com/JuliusBrussee/caveman` (public); `git log -1` → `655b7d9`; `node bin/install.js --help/--list`; `npm test` → 31/32.
- godmode: remote `github.com/arbazkhan971/godmode`; HEAD `8dceddc`; `bash tests/validate-structure.sh` → PASS 744 / FAIL 0; numeric benches timed out on Windows.
- openclaw-office: no `.git`; `IDENTITY.md`/`SOUL.md`/`TOOLS.md` are fill-in templates; `skills/consilium/` only.
- OpenManus: `ls C:/Projects/OpenManus` → absent.
- ZEUS: per `ATLAS/data/ATLAS-PROBLEMS-AND-V1-BAR-2026-06-26.md` — emotion wired (`ANUS/src/atlas/emotion.ts`,`pulse.ts`), gateway frozen (no source).

## 9. CEO blockers (real decisions only)

1. **Direction call:** these repos add token-economy + discipline, **not** Jarvis capability. If you want *more Jarvis*, the next money is **voice STT (currently dead)** and **hands (OpenManus checkout + `DAYTONA_API_KEY`)** — both need your go. If you want *cheaper/leaner Atlas*, the caveman extractions (P0/P1) need **no decision** — I can do them on your word.
2. **OpenManus hands** — checkout + Daytona credential = a budget/cred decision (only if you want real external hands).
3. Everything else here is REJECT/REFERENCE and needs nothing from you.

(Secret/credential rotation is explicitly deferred per your locked decision — not touched.)

## What we were about to forget (candor)

- **Atlas's autonomous brain-loop is inert** — `telegram.ts::autonomousBrainLoop` was gutted (2026-07-10). Atlas only reacts; the proactive assistant isn't running. Verified this sprint.
- **Voice is non-functional:** STT was OpenAI Whisper but that key is dead; **TTS never existed.** No local repo supplies free voice. So "Jarvis you talk to" is currently mute and deaf.
- **CAVEMAN wasn't ignored, but wasn't fully mined:** the `caveman` *skill* is already in Atlas's skill list, yet the higher-value `caveman-shrink` MCP proxy + deterministic compressor were never extracted.
- **No ready Jarvis CLI was sitting ignored** — ANUS is the real one; caveman/godmode are packs, not agents. We did **not** rebuild anything they already provide (Phase 2 tray + Phase 3 skills are net-new; the caveman voice skill was reused, not rebuilt).
- **Everything is still local-only** — `feat/arsenal-wiring` has no upstream; all sprint work (and this audit) is unpushed and unbacked.
- **OpenManus (the promised hands) is not even on disk** — the `action-lane.ts` path `C:/Projects/OpenManus` is dead. The single biggest gap between the plan and reality.
