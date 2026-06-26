# Atlas CLI — Architecture Decision Record

**Date:** 2026-04-26 (original) | 2026-05-04 (audit rewrite)
**Decision by:** Atlas (5 agent perspectives consulted)
**Audited by:** Orchestrator (code-verified 2026-05-04)
**Status:** PARTIAL — 2 of 7 decisions implemented

## Context

ANUS CLI is being reborn as Atlas CLI — the core runtime of the VOLAURA 5-product ecosystem. The end goal is a multi-agent platform where every user gets their own AI twin that lives in Life Simulator (Godot 4), learns from their data, and communicates with other twins.

---

## IMPLEMENTED

### 1. Runtime: Mastra (thin wrapper) — PARTIAL

**Status:** Imported, underused.

`@mastra/core` is in `package.json`. `mastra-agent.ts` wraps `Agent` class for `chat/remember/recall/reflect`. Swap-safe pattern works — callers never touch Mastra directly.

**What's missing from the ADR promise:**
- 3-tier memory (working + semantic + observational) — NOT USED. Memory is hand-rolled `readFile`/`writeFile` to markdown.
- AgentFS persistent storage — NOT USED
- Workflow suspend/resume — NOT USED
- Production observability — NOT USED

**Decision:** Keep Mastra, but either use its features or drop to `ai` SDK directly. Current state wastes a heavy dependency for one method (`Agent.generate`).

### 2. Model Router — DONE

**Status:** Fully implemented, not in original ADR.

`model-router.ts`: 7 providers (Ollama, Cerebras, Groq, NVIDIA, OpenAI, OpenRouter, Anthropic), cost-ordered routing, role-based selection (FAST/WORKER/JUDGE/CRITICAL), runtime fallback across providers. This works and is tested.

### 3. Rebrand: ANUS → Atlas CLI — PARTIAL

**Status:** Package renamed, directory not renamed, namespace wrong.

- `package.json` says `@ganbaroff/atlas-cli` (ADR said `@volaura/atlas-cli`)
- Binary is `atlas` ✓
- Git repo directory still named `ANUS`
- Published to GitHub Packages under wrong namespace

**Action needed:** Decide final namespace. `@volaura/atlas-cli` or `@ganbaroff/atlas-cli`. Pick one, update ADR.

---

## NOT IMPLEMENTED (PLANNED)

### 4. Protocols: MCP + A2A — NOT STARTED

ADR said:
- MCP (Anthropic) for agent↔tools
- A2A v1.2 (Google/Linux Foundation) for twin↔twin communication
- Signed Agent Cards for identity verification

**Reality:** Tools are plain Zod-schema functions passed to Mastra's `tools` bag. No MCP server, no MCP client, no A2A, no Agent Cards. Zero code.

**Prerequisite:** Mastra integration must deepen first. MCP makes sense when Atlas exposes tools to external agents.

### 5. Transport: NATS message bus — NOT STARTED

ADR said NATS for CLI↔FastAPI↔Godot. Sub-ms latency, JetStream persistence, embedded offline mode.

**Reality:** No `nats` dependency. No transport layer. CLI talks to LLM providers directly via HTTP.

**Prerequisite:** Needs a real use case (Godot bridge or multi-service deployment) before adding message bus complexity.

### 6. Data sovereignty: encrypted blob + DID — NOT STARTED

ADR said:
- User passphrase → PBKDF2 → AES-256-GCM key (client-side)
- Personality JSON encrypted before Supabase
- DID (Decentralized Identifier) for portable twin identity

**Reality:** `identity.ts` reads plaintext markdown from disk. No encryption, no key derivation, no DID spec. The word "DID" appears in identity field names but implements nothing.

**Prerequisite:** Twin prototype (Phase 5) must exist before encryption matters. Don't encrypt what doesn't exist yet.

---

## PHASE STATUS

| # | What | ADR Estimate | Actual Status |
|---|------|-------------|---------------|
| 0 | Rebrand ANUS → Atlas CLI | 2h | **PARTIAL** — pkg renamed, dir not, wrong namespace |
| 1 | Mastra spike | 2 days | **PARTIAL** — imported, one method used, no validation spike |
| 2 | Model router | 1 day | **DONE** — 7 providers, fallback, tested |
| 3 | Connect VOLAURA skills engine | 1 day | **DONE** — skill tools in CLI |
| 4 | NATS local + CLI↔API bridge | 2 days | **NOT STARTED** |
| 5 | Twin prototype | 3 days | **NOT STARTED** |
| 6 | Godot bridge | 5 days | **NOT STARTED** |
| 7 | A2A: Agent Cards, twin↔twin | 3 days | **NOT STARTED** |

---

## ERRATA (mistakes in original ADR)

1. **Ruflo stats inflated.** Original cited "31K stars, Claude-first, @alpha". Unverified — likely hallucinated by agent perspective. Removed from sources until verified.
2. **"1,043 files to update"** — fabricated number. Actual rename scope is package.json + README + a handful of references.
3. **`named_by` contradiction** — `identity.ts` has two conflicting values in the same file (line 39 vs line 66). Needs single source of truth.
4. **MCP claim false** — ADR said "MCP already in the CLI". It was not. Tools were always plain functions.

## Agent perspectives consulted (original, preserved)

1. **Architect:** Mastra for production memory + model routing
2. **Pragmatist:** Build minimal — frameworks die (overruled by #3)
3. **Devil's advocate:** Build-own = 15-20x cost at scale. Adopt Mastra, wrap thin.
4. **Security:** Client-encrypted blob + DID. User holds key.
5. **Game architect:** NATS bus. Sub-ms, offline-first, decoupled.

## Sources (verified)

- Mastra: https://mastra.ai/framework — in use, partially
- A2A Protocol: https://a2a-protocol.org/latest/specification/ — not yet used
- NATS: https://nats.io — not yet used
- ~~Ruflo: removed pending star count verification~~
- Aphae (Godot AI sim): https://github.com/rsanandres/aphae — reference only
- DID + VCs for agents: https://arxiv.org/html/2511.02841v1 — reference only
