# Atlas CLI

Persistent AI agent for the terminal. Multi-model, multi-perspective, memory-backed.

Part of the [VOLAURA](https://volaura.app) ecosystem.

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
atlas ping               # verify setup
atlas chat               # start talking
```

## Commands

| Command | What it does |
|---------|-------------|
| `atlas chat` | Interactive multi-model chat |
| `atlas run <skill>` | Execute a named skill |
| `atlas swarm <task>` | Fork-based parallel analysis with quality gate |
| `atlas swarm-deep <task>` | Route to Python swarm (13 perspectives, 4 DAG waves) |
| `atlas hive` | Show Python hive agent profiles |
| `atlas wake` | Identity recall from filesystem (no LLM call) |
| `atlas boot` | Full boot: identity + health + last session |
| `atlas cron` | Start 30-min autonomous health check cycle |
| `atlas health` | Run 7 diagnostic checks |
| `atlas identity` | Print identity JSON |
| `atlas models` | List available model providers |
| `atlas skills` | List available skills |
| `atlas telegram` | Start Telegram bot with voice input |
| `atlas ping` | Fast connectivity check |

## Configuration

### API keys (.env)

Set at least one. Cost order: free first, paid last.

| Variable | Provider | Cost |
|----------|----------|------|
| `CEREBRAS_API_KEY` | Cerebras | Free |
| `NVIDIA_API_KEY` | NVIDIA NIM | Free |
| `OLLAMA_URL` | Ollama (local) | Free |
| `OPENROUTER_API_KEY` | OpenRouter | Paid |
| `ANTHROPIC_API_KEY` | Anthropic | Paid |
| `OPENAI_API_KEY` | OpenAI (voice only) | Paid |
| `TELEGRAM_BOT_TOKEN` | Telegram bot | Free |

### Custom perspectives

Swarm perspectives are loaded from `~/.atlas/perspectives.json`:

```json
[
  {
    "name": "reviewer-1",
    "instruction": "Review for correctness and edge cases.",
    "provider": "cerebras"
  }
]
```

Override path: `ATLAS_PERSPECTIVES_PATH=/path/to/perspectives.json`

## Architecture

- **Multi-model fallback**: Cerebras -> Ollama -> NVIDIA -> OpenRouter -> Anthropic
- **Memory**: Obsidian-compatible vault, persistent across sessions
- **Swarm**: fork-based parallel agents with Jidoka quality gate
- **Cron**: 30-min self-check, health reports to memory vault
- **Dedup**: content deduplication for memory writes
- **Python bridge**: subprocess call to VOLAURA Python swarm

## Tests

```bash
npm test    # 87 tests across 21 files
```

Unit, integration, and E2E binary tests (build -> run compiled binary -> verify output).

## License

[Apache-2.0](./LICENSE)
