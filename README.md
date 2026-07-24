# Atlas CLI

Persistent AI agent for the terminal. Multi-model, multi-perspective, memory-backed.

Part of the [VOLAURA](https://volaura.app) ecosystem.

## What this repo is — and isn't

**Is:** the Atlas CLI shell — terminal commands, the deployed Telegram bot
runtime, local orchestration (exec-graph, operator dispatch, autonomy loop,
model routing). This is the **control surface**.

**Is not:** the canonical Atlas memory or the canonical swarm implementation
— those live in `C:\Projects\VOLAURA` (Python swarm, shared cross-session
memory). See [ATLAS-CANON.md](./ATLAS-CANON.md) for the full repo split,
and [docs/architecture/ATLAS-ARCHITECTURE.md](./docs/architecture/ATLAS-ARCHITECTURE.md)
for the system map.

## Local vs. cloud responsibilities

| | Cloud (Railway) | Local (CEO's machine) |
|---|---|---|
| **Runs** | Exactly one process: `node dist/cli.js telegram` | The interactive CLI, the desktop tray, the autonomy loop (via OS-level Task Scheduler, not a cloud cron) |
| **Owns writes to** | Nothing durable beyond its own process memory + Supabase session mirror | `state/exec-graph/` (the only place new tasks/goals/transitions are written), `config/policy.yaml` edits, local memory vault writes |
| **Why** | Always-on, restart-safe, minimal — no human needs to keep a machine on | Durable git-tracked state and interactive control belong where a human is actually sitting |

Full detail: [docs/architecture/ATLAS-ARCHITECTURE.md](./docs/architecture/ATLAS-ARCHITECTURE.md#local--cloud-boundary).

## Install

```bash
npm install @volaura/atlas-cli
# or clone and build:
git clone https://github.com/ganbaroff/atlas-cli.git
cd atlas-cli && npm install && npm run build
```

## Quick start

```bash
cp .env.example .env     # add at least one API key
atlas ping                # verify setup
atlas chat                 # start talking
```

## Safe boot / dev commands

Verified against `package.json`'s `scripts`:

```bash
npm run dev          # tsx src/cli.ts <command> — no build step, fastest loop
npm run build         # tsup src/cli.ts -> dist/ (esm + types)
npm start              # node dist/cli.js <command> — run the built binary
npm test                # vitest
npm run typecheck       # tsc --noEmit
```

`npm start`/`atlas` both point at `dist/cli.js` — rebuild (`npm run build`)
after any source change before relying on the built binary.

## Main components + entry points

| Component | Entry point | Status |
|---|---|---|
| Telegram bot runtime | `src/telegram.ts` (`atlas telegram`) | LIVE (deployed on Railway) |
| CLI | `src/cli.ts` (`atlas <command>`) | LIVE (local) |
| Model router | `src/model-router.ts` | LIVE |
| Notifier (proactive-send gate) | `src/atlas/notify.ts` | LIVE |
| Policy loader | `src/atlas/policy.ts` + `config/policy.yaml` | LIVE |
| **exec-graph** (task authority, EB-0) | `src/exec-graph/*` | IMPLEMENTED-LOCAL — tests green (`src/__tests__/exec-graph.test.ts`), no live-bot task activity observed yet |
| Operator dispatch/evaluate/promote | `src/operator/*` | IMPLEMENTED-LOCAL |
| Task spawner (Telegram `/task`) | `src/atlas/task-spawner.ts` | LIVE, but classified TEMPORARY ADAPTER — see [ADR-0004](./docs/adr/0004-legacy-task-source-cutover.md) |
| Autonomy loop (V1 alert semantics) | `src/atlas/autonomy-loop.ts` | IMPLEMENTED-LOCAL / LOCAL-NOTIFY-VERIFIED — not scheduled anywhere yet; see [docs/AUTONOMY-V0.md](./docs/AUTONOMY-V0.md) |
| Desktop tray | `apps/desktop/` | LOCAL-VERIFIED — see [docs/DESKTOP-SHELL.md](./docs/DESKTOP-SHELL.md) |
| Swarm (TS fork-parallel) | `src/swarm.ts` | LIVE |
| Swarm (Python bridge to VOLAURA) | `src/atlas/python-bridge.ts` | LIVE when VOLAURA is present at `C:\Projects\VOLAURA`; falls back to TS swarm otherwise |
| Voice input (Telegram) | `src/telegram.ts`'s `bot.on('voice', ...)` + `transcribe()` (Whisper) | LIVE, gated on `OPENAI_API_KEY` — replies `[voice unavailable — no OpenAI key]` when unset |

## Commands

Grouped by area. Full option flags: `atlas <command> --help` or read
`src/cli.ts` (this table is refreshed against it, not hand-guessed).

**Core**

| Command | What it does |
|---------|-------------|
| `atlas chat` | Interactive multi-model chat (`--role FAST\|WORKER\|JUDGE\|CRITICAL`) |
| `atlas run <skill>` | Execute a named VOLAURA skill |
| `atlas identity` | Print Atlas identity JSON |
| `atlas control <command> [lane...]` | Update Atlas control state (pause/stop/resume/reroute) |
| `atlas models` | List available model providers (based on configured API keys) |
| `atlas ping` | Fast connectivity check |
| `atlas wake` / `atlas boot` | Identity + memory recall / full boot (identity + health + last session) |
| `atlas status` | One-line status: health, today's spend, brain-loop queue, heartbeat (CLI-only — no exec-graph section; see [morning-brief-and-status runbook](./docs/runbooks/morning-brief-and-status.md)) |
| `atlas health` | Quick health check (no persist) |
| `atlas cron once\|start\|status` | Periodic self-check, writes health reports to memory |
| `atlas skills` | List available VOLAURA skills |
| `atlas telegram` | Start Atlas as the Telegram bot (`TELEGRAM_BOT_TOKEN` required) |

**exec-graph (EB-0 task authority)** — see [src/exec-graph/README.md](./src/exec-graph/README.md), [ADR-0001](./docs/adr/0001-one-task-authority-exec-graph.md)

| Command | What it does |
|---------|-------------|
| `atlas goal add <title...>` | Create a new exec-graph goal |
| `atlas task add <title...> --goal <id>` | Create a new task under a goal |
| `atlas task move <id> <status> --actor <actor>` | Transition a task (evidence-gated for `verified`/`evidence-submitted`) |
| `atlas task show <id>` | Show one task, full transition + evidence history |
| `atlas task list [--status <s>]` | List tasks, optionally filtered |
| `atlas task import <title...> --goal <id> --source-kind <k> --source-ref <r>` | Idempotent import from a legacy source — see [legacy-task-cutover runbook](./docs/runbooks/legacy-task-cutover.md) |
| `atlas graph status` | Counts per status + tasks waiting on decision/verification |
| `atlas graph verify` | Rebuild the snapshot from the ledger, diff against disk — see [exec-graph-recovery runbook](./docs/runbooks/exec-graph-recovery.md) |

**Operator dispatch**

| Command | What it does |
|---------|-------------|
| `atlas operator status` | Show operator state and required artifacts |
| `atlas operator validate <task>` | Validate an operator task contract |
| `atlas operator dispatch <task>` | Dispatch an operator task and write a trace |
| `atlas operator lifecycle <task>` | Run dispatch -> evaluate -> promote |
| `atlas operator intake <intent...>` | Compile explicit CEO intent into an operator task and run it |
| `atlas operator control <command> [lane...]` | Update operator control state |

**Autonomy / repo watch**

| Command | What it does |
|---------|-------------|
| `atlas autonomy-tick [--notify]` | Run ONE tick of the local autonomy loop (read-only signals; notify only on real transitions) |
| `atlas autonomy-test-notify` | Send one controlled test notification through the canonical notify layer |
| `atlas repo-watch [--notify]` | Check configured git repos (read-only), optionally notify |
| `atlas capture [--summarize]` | Capture the primary screen (read-only), optional capped vision summary |

**Swarm**

| Command | What it does |
|---------|-------------|
| `atlas swarm <task>` | Fork-based parallel analysis with quality gate |
| `atlas swarm-deep <task> [--mode <mode>]` | Route to VOLAURA Python swarm (13 perspectives, 4 DAG waves); falls back to TS swarm if VOLAURA isn't present |
| `atlas hive` | Show Python hive agent profiles |

## Configuration

### API keys (.env)

Set at least one. Cost order: free first, paid last.

| Variable | Provider | Cost |
|----------|----------|------|
| `GROQ_API_KEY` | Groq | Free / limited |
| `NVIDIA_API_KEY` | NVIDIA NIM | Free |
| `OLLAMA_URL` | Ollama (local) | Free |
| `OPENROUTER_API_KEY` | OpenRouter | Paid |
| `ANTHROPIC_API_KEY` | Anthropic | Paid |
| `OPENAI_API_KEY` | OpenAI (voice transcription only) | Paid |
| `TELEGRAM_BOT_TOKEN` | Telegram bot | Free |
| `TELEGRAM_CEO_CHAT_ID` | Inbound-auth gate + outbound target — bot refuses ALL inbound messages if unset | — |

### Custom perspectives

Swarm perspectives are loaded from `~/.atlas/perspectives.json`:

```json
[
  {
    "name": "reviewer-1",
    "instruction": "Review for correctness and edge cases.",
    "provider": "nvidia"
  }
]
```

Override path: `ATLAS_PERSPECTIVES_PATH=/path/to/perspectives.json`

## Where things live

| What | Where |
|---|---|
| System architecture map | [docs/architecture/ATLAS-ARCHITECTURE.md](./docs/architecture/ATLAS-ARCHITECTURE.md) |
| Design decisions | [docs/adr/](./docs/adr/) (0001–0005, EB-0) |
| Operational how-tos | [docs/runbooks/](./docs/runbooks/) |
| Task/execution state | `state/exec-graph/` (git-tracked) — index: [docs/state-and-evidence-index.md](./docs/state-and-evidence-index.md) |
| Guardrail policy | `config/policy.yaml`, loaded by `src/atlas/policy.ts` — see [docs/POLICY.md](./docs/POLICY.md) |
| Panic / pause | [docs/PANIC.md](./docs/PANIC.md), [atlas-pause-and-resume runbook](./docs/runbooks/atlas-pause-and-resume.md) |
| Legacy command-queue contract | [docs/QUEUE-CONTRACT.md](./docs/QUEUE-CONTRACT.md) *(historical — see [ADR-0004](./docs/adr/0004-legacy-task-source-cutover.md)'s correction: the in-repo producers it describes were disabled 2026-07-10)* |
| Repo-split canon (ANUS vs VOLAURA) | [ATLAS-CANON.md](./ATLAS-CANON.md) |

## Never change casually

These are load-bearing safety/audit surfaces. Changing them needs the same
scrutiny as a production migration, not a routine edit:

- **`src/atlas/notify.ts`'s gate** — the only path a proactive CEO message
  can take. Widening `ALLOWED` or bypassing `shouldNotify()` reopens the
  alert-fatigue problem this file exists to prevent (see [ADR-0005](./docs/adr/0005-ceo-notification-authority-stays-canonical-notifier.md)).
- **`src/atlas/policy.ts`'s fail-closed defaults** — a policy load failure
  in production must degrade to the empty autonomy whitelist, never to
  "allow everything." Do not flip this to fail-open.
- **`state/exec-graph/ledger.jsonl`'s append-only invariant** — never
  hand-edit or rewrite existing lines. See
  [exec-graph-recovery runbook](./docs/runbooks/exec-graph-recovery.md) and
  [ADR-0003](./docs/adr/0003-append-only-ledger-plus-snapshot.md).
- **Telegram inbound-auth gate** (`telegram.ts`'s `isAuthorizedChat` check)
  — the only thing stopping an owner-less, tool-equipped bot from acting on
  a stranger's message. It fails closed on a missing `TELEGRAM_CEO_CHAT_ID`;
  keep it that way.

## Tests

```bash
npm test    # vitest — see current suite for exact counts
```

Unit, integration, and E2E binary tests (build -> run compiled binary ->
verify output).

## License

[Apache-2.0](./LICENSE)
