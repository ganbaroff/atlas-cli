# Atlas CLI

Persistent AI agent. Terminal surface of the VOLAURA ecosystem.

Built on Mastra + Vercel AI SDK. 28 source files, 21 test files, 88 tests — all green.

## Commands

```bash
atlas chat                # interactive chat (multi-model)
atlas run <skill>         # execute a VOLAURA skill by name
atlas swarm <task>        # fork-based parallel agents with Jidoka gate
atlas swarm-deep <task>   # route to VOLAURA Python swarm (13 perspectives, 4 DAG waves)
atlas hive                # show Python hive agent profiles
atlas wake                # identity recall from filesystem memory (no LLM needed)
atlas boot                # Jarvis-like boot — identity + health + last session
atlas cron                # 30-min autonomous health check cycle
atlas health              # quick health diagnostics (7 checks)
atlas identity            # Atlas identity JSON
atlas models              # list available providers
atlas skills              # list VOLAURA skills
atlas telegram            # Telegram bot (Whisper voice input)
atlas ping                # fast health check
```

## Architecture

- **Multi-model fallback**: Cerebras → Ollama → NVIDIA → OpenRouter → Anthropic
- **Memory**: Obsidian vault (`C:\Projects\VOLAURA\memory\atlas\`) — persistent across sessions
- **Swarm**: fork-based parallel agents, named perspectives (Engineer/Strategist/Skeptic/Product/Operator)
- **Cron**: 30-min self-check, writes health reports to memory vault
- **Telegram**: full bot with voice (Whisper), 2.3K-token brain context
- **Python bridge**: calls VOLAURA Python swarm via subprocess
- **Dedup**: Cloudflare-inspired content deduplication for memory writes
- **Conversation store**: per-session message persistence
- **Dashboard**: `dashboard.html` — visual agent state

## Setup

```bash
cp .env.example .env   # add at least one API key
npm install
npx tsx src/cli.ts ping
```

## Tests

```bash
npm test                 # 88 tests across 21 files
```

Includes unit tests, integration tests, and E2E binary tests (build → run compiled binary → verify output).

## License

[Apache-2.0](./LICENSE)
