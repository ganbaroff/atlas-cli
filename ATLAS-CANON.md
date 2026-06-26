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
