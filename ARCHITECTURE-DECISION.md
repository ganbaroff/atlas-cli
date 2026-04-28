# Atlas CLI — Architecture Decision Record

**Date:** 2026-04-26
**Decision by:** Atlas (5 agent perspectives consulted)
**Status:** APPROVED — ready for implementation

## Context

ANUS CLI is being reborn as Atlas CLI — the core runtime of the VOLAURA 5-product ecosystem. The end goal is a multi-agent platform where every user gets their own AI twin that lives in Life Simulator (Godot 4), learns from their data, and communicates with other twins.

## Decisions

### 1. Runtime: Mastra (thin wrapper)

**Consensus:** 3/5 agents recommend Mastra. Build-your-own is 15-20x more expensive at platform scale.

Mastra provides: 3-tier memory (working + semantic + observational), model-agnostic routing (3,300+ models), AgentFS persistent storage, workflow suspend/resume, production observability.

**Mitigation:** Thin wrapper pattern. If Mastra dies or blocks us, swap internals without changing our API surface.

**Validation needed:** 2-day spike to verify esbuild compatibility and Godot event loop integration.

### 2. Protocols: MCP + A2A

- MCP (Anthropic) for agent↔tools — already in the CLI
- A2A v1.2 (Google/Linux Foundation) for twin↔twin communication
- Signed Agent Cards for identity verification

### 3. Transport: NATS message bus

Between Atlas CLI, FastAPI backend, Godot client. Sub-ms local latency, JetStream persistence, embedded mode for offline. Single binary (10MB).

Clients: `nats.gd` (Godot), `nats-py` (FastAPI), `nats.ws` (TypeScript CLI).

### 4. Data sovereignty: encrypted blob + DID

User passphrase → PBKDF2 → AES-256-GCM key (client-side only).
Personality JSON encrypted before Supabase. Platform sees ciphertext only.
DID (Decentralized Identifier) for portable twin identity.
Export = DID document + encrypted blob + key derivation params.

### 5. Rebrand: ANUS → Atlas CLI

Package: `@volaura/atlas-cli`. Binary: `atlas`. 1,043 files to update.

## Phases

| # | What | Effort |
|---|------|--------|
| 0 | Rebrand ANUS → Atlas CLI | 2h |
| 1 | Mastra spike: install, verify esbuild, basic agent loop | 2 days |
| 2 | Model router: Grok + Ollama + Cerebras via Mastra | 1 day |
| 3 | Connect VOLAURA skills engine (HTTP) | 1 day |
| 4 | NATS local + CLI↔API bridge | 2 days |
| 5 | Twin prototype: 1 user, encrypted personality, Supabase | 3 days |
| 6 | Godot bridge: nats.gd + twin NPC | 5 days |
| 7 | A2A: Agent Cards, twin↔twin messaging | 3 days |

## Agent perspectives consulted

1. **Architect:** Mastra for production memory + model routing
2. **Pragmatist:** Build minimal — frameworks die (overruled by #3)
3. **Devil's advocate:** Build-own = 15-20x cost at scale. Adopt Mastra, wrap thin.
4. **Security:** Client-encrypted blob + DID. User holds key.
5. **Game architect:** NATS bus. Sub-ms, offline-first, decoupled.

## Sources

- Mastra: https://mastra.ai/framework (22K stars, $13M YC, 300K npm/week)
- Ruflo: https://github.com/ruvnet/ruflo (31K stars, Claude-first, @alpha)
- A2A Protocol: https://a2a-protocol.org/latest/specification/ (v1.2, 150+ orgs)
- Aphae (Godot AI sim): https://github.com/rsanandres/aphae
- DID + VCs for agents: https://arxiv.org/html/2511.02841v1
- NATS: https://nats.io (10MB binary, JetStream persistence)
