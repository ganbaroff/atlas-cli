# Atlas Canon

This file defines the current canonical layout of Atlas across `ANUS` and `VOLAURA`.

Use this as the source of truth when deciding where to edit code, where memory lives, and which directories are archival only.

## Current operating model

Atlas is currently split across two repositories:

1. `C:\Users\user\OneDrive\Documents\GitHub\ANUS`
   - Atlas CLI shell
   - terminal commands
   - local TypeScript orchestration
   - Telegram/runtime entrypoints

2. `C:\Projects\VOLAURA`
   - canonical Atlas memory
   - canonical swarm runtime
   - Python swarm implementation
   - shared product-facing ecosystem state

This is intentional for now.

`ANUS` is the control surface.
`VOLAURA` is the canonical brain and swarm home.

## What is canonical right now

Edit these locations when you mean to change the real agent state:

- Atlas memory: `C:\Projects\VOLAURA\memory\atlas`
- Swarm state: `C:\Projects\VOLAURA\memory\swarm`
- Shared bus: `C:\Projects\VOLAURA\memory\shared-bus`
- Python swarm code: `C:\Projects\VOLAURA\packages\swarm`

Edit these locations when you mean to change the CLI shell:

- CLI source: `C:\Users\user\OneDrive\Documents\GitHub\ANUS\src`
- CLI scripts: `C:\Users\user\OneDrive\Documents\GitHub\ANUS\scripts`
- CLI docs: `C:\Users\user\OneDrive\Documents\GitHub\ANUS\README.md`

## What is not canonical

Do not treat these as the source of truth for the real agent:

- `C:\Users\user\OneDrive\Documents\GitHub\ANUS\dist`
  - compiled output only
- `C:\Users\user\OneDrive\Documents\GitHub\ANUS\_salvage`
  - archival recovery layer
- `C:\Users\user\OneDrive\Documents\GitHub\ANUS\memory`
  - local CLI-side data only, not the full canonical Atlas vault

## Execution-state authority (EB-0 amendment, 2026-07-17)

The split above still governs identity/memory/swarm vs. CLI shell. It does
**not** answer a narrower question EB-0 introduced: for a specific piece of
Atlas-managed *work* (a task, with a status and evidence), which repo is
the ground truth?

- VOLAURA remains intent/strategy + memory canon — unchanged by this
  amendment.
- **Machine execution state for new Atlas-managed work is ANUS
  `state/exec-graph`** (git-tracked, append-only ledger + derived
  snapshot), not VOLAURA markdown. See ADR-0001
  (`docs/adr/0001-one-task-authority-exec-graph.md`) and ADR-0002
  (`docs/adr/0002-volaura-intent-vs-anus-execution-state.md`).
- Why execution-critical state does not live in VOLAURA: VOLAURA has
  historically spanned multiple long-lived branches without a single
  reconciled state (branch fragmentation), and
  `C:\Projects\VOLAURA\memory\shared-bus` is gitignored, so state written
  there is not reliably durable or diffable the way `state/exec-graph/` is.
  **Status: known issue, not fixed by this amendment — owner: VOLAURA
  chat.** See ADR-0002 for the full reasoning and rollback conditions.
- VOLAURA's `memory/atlas/work-queue/` markdown is a read-only import
  source into exec-graph (provenance `volaura-work-queue:<filename>`); it
  is not deleted or migrated, it simply stops being a task authority for
  new work. See `docs/adr/0004-legacy-task-source-cutover.md`.

## Environment contract

`ANUS` must point to `VOLAURA` explicitly:

```env
MEMORY_ROOT=C:\Projects\VOLAURA
VOLAURA_ROOT=C:\Projects\VOLAURA
```

That keeps Atlas from accidentally turning into two separate memory-bearing agents.

## Practical rule

If you ask:

- "Where does Atlas remember?" -> `VOLAURA`
- "Where does Python swarm live?" -> `VOLAURA`
- "Where do CLI commands live?" -> `ANUS`
- "Where should I debug shell behavior?" -> `ANUS`
- "Where should I debug wake memory?" -> `VOLAURA`

## Long-term target

This is a transitional architecture, not the final one.

The long-term target should be:

1. Extract `Atlas Core` into its own canonical layer
2. Make both `ANUS` and `VOLAURA` depend on that layer
3. Stop relying on one product repo as the permanent home of Atlas memory contracts

Target shape:

```text
Atlas Core
|- identity
|- memory contracts
|- swarm interfaces
|- shared schemas

ANUS -> Atlas Core
VOLAURA -> Atlas Core
```

Until that extraction happens, `VOLAURA` remains the single source of truth.
