# Atlas — Integrations Inventory

> Author: Atlas (Local CTO lane) · Date: 2026-07-16 · Evidence-only, tool-verified.
> **No secret values appear in this document** — key names, file paths, and
> present/absent status only. Emails masked. This maps what Atlas can reach and
> how to call it safely; it does not change any wiring.
>
> Origin note (accurate to baseline): the **cloud bot is the existing Jarvis brain**
> (live on Railway since before this sprint). This sprint added the **local shell +
> policy gate + read-only skills** on top. Nothing here was "built from zero."

## 0. TL;DR matrix

| Integration | Type | Status | R/W | Used by | How Atlas calls (safely) | Risk |
|---|---|---|---|---|---|---|
| NVIDIA NIM | LLM (free, tier 0) | **Live** | — | model-router | free-first; spend-policy gate | low |
| freellmapi (Gemini gw) | LLM (free, tier 0) | **Live** | — | model-router | needs KEY+BASE_URL; host kept secret | single-IP SPOF |
| Anthropic | LLM (paid, tier 2) | **Live** | — | model-router (`@ai-sdk/anthropic`) | `ATLAS_ALLOW_PAID=1`; excluded from swarm | cost |
| Groq | LLM (free) | **Dead** | — | model-router | key commented (invalid 2026-04-30) | — |
| OpenAI (+Whisper STT) | LLM/voice (paid) | **Dead** | — | model-router, telegram STT | key commented (quota 2026-04-29) | **voice STT broken** |
| OpenRouter / Ollama | LLM | **Unused** | — | model-router | never configured | — |
| Cerebras | LLM | **Dead/env-only** | — | none (removed from registry) | no code path | stale key in .env |
| Supabase | DB / memory + cmd queue | **Live** | R/W | supabase-memory.ts | service-role key; file fallback | durable memory layer |
| PostHog | Analytics | **Live** | W | analytics.ts | anon, silent-fail | low |
| Telegram (primary bot) | Control plane | **Live** | R/W | telegram.ts (Telegraf) | CEO-only allowlist; `/pause` | primary UI |
| Railway | Hosting/deploy | **Live** | R/W | deploy.ts, health :3000 | manual deploy; healthcheck | ephemeral volume |
| GitHub (`gh` CLI) | Deploy orchestration | **Live** | R/W | deploy.ts | CEO-confirm split | — |
| Google (gcloud) | Cloud / Gemini | **Live (user-authed)** | R | gcloud only (no app code) | AI-Studio project; Gemini via freellmapi gw | loose SA/Admin keys on disk |
| MCP servers | Tooling | see §4 | mixed | Claude clients | per-server auth | 1 config has literal secrets |
| Stripe | Payments | **Not wired** | — | none | — | — |

## 1. Google deep-dive

- **gcloud SDK installed & authed:** `C:\Users\user\AppData\Local\Google\Cloud SDK`. One account (masked) `y***@gmail.com`, active config `default` → project **`gen-lang-client-0321449510`** (Google **AI Studio / Generative Language** auto-project). No zone/region.
- **Store** (paths only, never opened): `AppData\Roaming\gcloud\` → `credentials.db`, `access_tokens.db`, `legacy_credentials\y***@gmail.com\`. **No `application_default_credentials.json`** (no ADC file — auth is the user login, not ADC).
- **Gemini is reached via the freellmapi HTTP gateway, not a Google SDK** — no `@google/genai`/`googleapis`/`@google-cloud/*` import anywhere in Atlas/VOLAURA code. So Google is **authenticated at the OS level but barely consumed by code**.
- **No Gmail/Calendar/Drive/Sheets/Vertex wiring.** Those need their own OAuth scopes — a CEO decision (see [SKILL-EMAIL.md](SKILL-EMAIL.md)).

### Google credential files on disk (paths only — contents NEVER opened)
| Path | What | Status |
|---|---|---|
| `C:\Users\user\Downloads\Код и данные\mindshift-441e8-firebase-adminsdk-*.json` | **Firebase Admin SDK private key** (proj `mindshift-441e8`) | **🔴 HIGH — loose in Downloads** |
| `C:\Projects\VOLAURA\apps\api\.gcp-service-account.json` (+ `gcp-service-account.json`) | GCP service-account keys | 🟠 checked into repo, unreferenced/stale |
| `C:\Projects\VOLAURA\secrets\ecosystem-keys.md` (17.6K) | likely aggregates keys | 🟠 not opened; secrets/ dir |
| `C:\Projects\mindshift\android\app\google-services.json` | Firebase Android config (`mindshift-441e8`) | mobile app config |
| `C:\Users\user\Downloads\Код и данные\google-services.json` | Firebase Android (loose copy) | stray |
| `C:\Users\user\.notebooklm\`, `...\.notebooklm-home\storage_state.json` | NotebookLM logged-in Google browser session | account unverified |

- **Env key names (Google):** VOLAURA `apps/api/.env` → `GEMINI_API_KEY`, `FIREBASE_MINDSHIFT_CREDENTIALS_B64` (base64 Firebase Admin SA, FCM push — **no `firebase-admin` import → planned/stale**). ANUS → only `FREELLMAPI_*` (no direct Google key). Absent everywhere: `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_*`, `GCP_*`, OAuth client IDs.
- **Accounts:** only `y***@gmail.com` is label-confirmable; the Firebase project and NotebookLM session are Google-backed but their identity was not verified (files not opened) — likely the same personal account.

## 2. API catalog (wired providers)

Registry: `src/model-router.ts` (`MODEL_REGISTRY`, cost-ordered, free-first). Governance: `src/atlas/spend-policy.ts`.

- **Live LLM path today:** NVIDIA NIM (llama-3.3-70b) + freellmapi (gemini-2.5-flash) — both **free** — with **Anthropic** (sonnet-4) as the paid/CRITICAL last resort (excluded from swarm per canon).
- **Dead/keyed-out:** Groq (`GROQ_API_KEY` commented, invalid 2026-04-30), OpenAI (`OPENAI_API_KEY` commented, quota 2026-04-29). **Consequence: Whisper voice STT is dead** — it shares the disabled OpenAI key (`telegram.ts:306`).
- **Unused:** OpenRouter (no key), Ollama (no `OLLAMA_URL`).
- **Registry-absent:** Cerebras — `CEREBRAS_API_KEY` persists in `.env` but there is **no code path** (cut after the $7.25 burn, ADR-013).
- **Supabase** (`atlas/supabase-memory.ts`): durable memory + the Telegram→Claude-Code command queue. Tables: `bot_sessions`, `bot_messages`, `bot_heartbeats`, `atlas_command_queue` (idempotency-keyed), `atlas_learnings` (emotional memory w/ decay). Mitigates Railway's ephemeral volume.
- **PostHog** (`analytics.ts`): anonymous analytics, optional, silent-fail.
- **Telegram** (`telegram.ts`): the control plane; replies route through the free-first model-router; CEO-only allowlist. A second `TELEGRAM_CREATOR_BOT_TOKEN` exists in `.env.example` only — **unused** (planned content bot).
- **Railway / GitHub `gh`:** hosting + deploy orchestration (PR merge behind CEO confirm).
- **FinOps gates (all providers):** `ATLAS_DAILY_TOKEN_CAP`, `ATLAS_ALLOW_PAID` (paid hard-blocked unless =1), `ATLAS_PAUSE` kill-switch, `ATLAS_BRAIN_QUEUE_CAP` — now consolidated in `config/policy.yaml` (Phase 1).

## 3. MCP catalog

**Session-level (this Claude Code harness — injected at runtime, not on disk):**
claude-in-chrome (real-Chrome control), Claude_Browser (in-app browser), computer-use (desktop), visualize, **metricool** (social), **plugin:azure** (Azure), **plugin:telegram** (bot reply), mcp-registry, scheduled-tasks, ccd_session\*. These are available to *me* (the agent), not to the cloud bot.

**On-disk client configs:**
- **Cursor** (`~\.cursor\mcp.json`): `posthog` (http, no secret).
- **Claude Desktop**: no inline `mcpServers`; MCP via extensions `figma` (1.0.8), `windows-mcp` (0.7.1).
- **Claude Code global** (`~\.claude.json`): `metricool` (http).
- **Claude Code project** (`C:\Projects\VOLAURA\.mcp.json`): `playwright` (stdio), `sentry` (http), **`supabase` (stdio — secret in args)**, **`mem0` (http — secret in Authorization header)**, `obsidian` (localhost).
- **Plugin-bundled**: `azure` (stdio, runtime `az` auth), `telegram` (stdio, token via plugin env).
- **Enabled plugins** (`~\.claude\settings.json`): azure, telegram, frontend-design, karpathy-skills, 5× trailofbits (security-audit), volaura-core. MCP allowlist: github, context7, stitch, playwright, supabase, sentry, obsidian.
- **Empty/none**: Antigravity MCP configs are 0 bytes; VS Code has no MCP refs.

**⚠ One config embeds LITERAL secrets:** `C:\Projects\VOLAURA\.mcp.json` (supabase args + mem0 auth header). All others use tokenless URLs, runtime auth, or `${ENV}` placeholders.

## 4. Recommended next skill wiring (ordered)

1. **Fix voice STT (broken today).** OpenAI/Whisper is dead. Route STT to a free path — Gemini audio via freellmapi, or NVIDIA NIM's ASR — so Telegram voice notes work again. Highest value, currently regressed.
2. **Secret hygiene on `VOLAURA/.mcp.json`.** Move the supabase + mem0 literal secrets to `${ENV}` placeholders and rotate them. It's a config file inside a git repo — a leak risk.
3. **Direct Gemini via ADC.** The `gen-lang-client` project is already authed; a governed `gemini` provider (free) adds redundancy against the freellmapi single-IP SPOF.
4. **Wire the governed tool registry.** `src/tools/registry.ts` (`getToolDict`) exists but is untracked WIP not yet consumed by `agent.ts` — unify CLI/telegram/swarm tool sets through it.
5. **Calendar/Gmail read skill** — only after the CEO OAuth-scope decision (email SKIP stands).

## 5. CEO blockers (need a decision)

**🔴 SECURITY (do first — exposed live credentials):**
1. **Firebase Admin SDK private key loose in `Downloads\Код и данные\`** (`mindshift-441e8-firebase-adminsdk-*.json`). An Admin SDK key = full backend/FCM access to that Firebase project. **Rotate it and move it out of Downloads.**
2. **Two GCP service-account keys checked into the VOLAURA repo** (`apps/api/.gcp-service-account.json` + variant) — even if `.gitignore`'d, they sit in a repo tree. Rotate + remove; confirm they're gitignored.
3. **Literal secrets in `VOLAURA/.mcp.json`** (supabase args + mem0 auth header) — rotate + move to `${ENV}`.
4. **`VOLAURA\secrets\ecosystem-keys.md`** likely aggregates keys in plaintext — review/rotate; I did not open it.

**🟠 OPERATIONAL:**
5. **Nothing is pushed.** All work (incl. this sprint's 3 commits) sits on local `feat/arsenal-wiring` with **no upstream** — unbacked if the disk dies. Say the word to push.
6. **Voice STT dead** — OpenAI/Whisper key disabled; pick a free STT replacement or accept voice-in is down.
7. **Gmail/Calendar OAuth scope** — needed for the email/calendar skills (strategy + TOS).
8. **screen_capture AV allowlist** — Defender blocks scripted capture; your call to allowlist `apps/desktop/capture-screen.ps1` or not.
9. **freellmapi single-IP gateway** — a SPOF for the "free blood"; §4 item 3 (direct Gemini via the authed AI-Studio project) mitigates.

## 6. What I see but haven't said (candor — per CEO request)

- **The autonomous brain-loop is inert.** `telegram.ts::autonomousBrainLoop` was gutted (board P0, 2026-07-10) and now does nothing — Atlas **only reacts**; the "proactive chief-of-staff" is not running. Restoring it behind the Phase-1 whitelist is real work, not a checkbox.
- **Everything is local + dirty.** ANUS tree carries untracked WIP (`src/tools/registry.ts`, `memory/atlas/CAPABILITIES-PRIVATE.md`) and a **malformed `C:ProjectsVOLAURA\` directory** (a broken-path artifact from a bad junction/symlink write) sitting at the ANUS root. VOLAURA is 17-files dirty. This is the "trust gap / theater" the master plan flagged — state that never lands.
- **Secrets are reachable through the workspace junction** (`MANIFEST.json` warns `C:\Projects\ATLAS\apps\cli\.env` is reachable) — plus the literal secrets in `VOLAURA/.mcp.json`. The blast radius of a leaked path is larger than it looks.
- **Planning sprawl.** ~20 `ATLAS-*.md` plan/audit docs across VOLAURA + `ATLAS/data`. The master plan itself warns against scatter; this inventory should not become #21 — it's a map, not a plan.
- **Memory is split-brain** (ANUS symlinks into VOLAURA; both dirty). The master plan calls durable memory the #1 unblocker.

## 7. Receipts index (no secrets)

- Google: `gcloud auth list`, `gcloud config configurations list` (emails masked); `ls AppData\Roaming\gcloud\`.
- APIs: `src/model-router.ts`, `.env`/`.env.example` (key names via `sed 's/=.*/=<redacted>/'`), `src/atlas/supabase-memory.ts`, `analytics.ts`, `telegram.ts`, `spend-policy.ts`.
- MCP: `~\.cursor\mcp.json`, `~\.claude.json`, `C:\Projects\VOLAURA\.mcp.json`, `~\.claude\settings.json` (keys-only), plugin cache under `~\.claude\plugins\`.
- Git posture: `git -C ANUS remote -v`, branch `feat/arsenal-wiring` has no upstream (`git log @{u}..HEAD` → no upstream).
- Cloud health: `curl .../health` → 200.

## Appendix — how the desktop tray and cloud bot relate (for CEO)

The **cloud bot** (Railway, `volaurabot`) is the brain: it holds the conversation,
runs the model-router, owns memory (Supabase), and is driven over **Telegram** —
that is the real Jarvis and it runs 24/7 whether or not your PC is on. The **desktop
tray** (this sprint) is a thin **local** window onto it: it *reads* the bot's health
and gives you a local **panic** switch for anything Atlas runs on your own machine.
The tray is not a second brain and does not talk for the bot — instant cloud pause is
still Telegram `/pause`; durable pause is the Railway variable. Local shell + policy +
skills live on your PC; the brain lives in the cloud.
