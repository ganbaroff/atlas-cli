# Atlas CLI — Research Repos (swarm-sourced 2026-04-26)

Repos to study and steal patterns from, ranked by priority.

## Priority 1 — Memory Architecture

**[letta-ai/letta](https://github.com/letta-ai/letta)** ~22K stars
3-tier memory: core (always in context), recall (searchable history), archival (vector DB). Agent-file (.af) format for serializable state. Map to Atlas: core = wake context, recall = journal search, archival = Obsidian vault via engraph.

## Priority 2 — Obsidian + Agent Hooks

**[breferrari/obsidian-mind](https://github.com/breferrari/obsidian-mind)**
Built for Claude Code. SessionStart hook auto-injects goals + projects + recent changes. MEMORY.md as pointer, brain/ as storage. Steal: preSession hook, pointer vs storage separation.

## Priority 3 — Vault Search

**[devwhodevs/engraph](https://github.com/devwhodevs/engraph)**
Obsidian vault → 5-lane hybrid search (semantic + full-text + wikilink graph + temporal + LLM rerank). MCP server. Steal: fusion search for Atlas recall().

## Priority 4 — A2A Protocol (TypeScript)

**[a2aproject/a2a-js](https://github.com/a2aproject/a2a-js)** 516 stars
Official TypeScript SDK. Agent Cards, AgentExecutor interface, SSE streaming. Steal: Agent Card schema, executor pattern for twin↔twin.

## Priority 5 — Wiki Cross-Linking

**[Ar9av/obsidian-wiki](https://github.com/Ar9av/obsidian-wiki)**
Karpathy pattern. Cross-linker scans unlinked mentions, weaves [[wikilinks]]. Taxonomy enforcement. Multi-source ingest. Steal: cross-linking pass for compile-wiki tool.

## Priority 6 — Terminal UI

**[assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui)** (Ink branch)
Composable primitives: Thread, Composer, Message. Ink terminal target with ANSI markdown. ToolFallback spinner. Steal: primitive architecture, shared runtime (web vs terminal).

## Priority 7 — Self-Modification

**[danielmiessler/Personal_AI_Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure)**
PAI for single principal. Self-improvement loop, goal/contact injection. Steal: principal model, self-modification pattern.

## Priority 8 — Godot + AI

**[SleeeepyZhou/AIdot](https://github.com/SleeeepyZhou/AIdot)**
Multi-agent for Godot with MCP-Godot-sdk. Steal: MCP-Godot bridge for Life Simulator integration.
