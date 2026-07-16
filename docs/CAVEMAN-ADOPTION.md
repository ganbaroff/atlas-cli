# CAVEMAN-SHRINK Adoption (Package A1)

Optional, deterministic tool-description compressor. Cuts the token overhead
of the tool-definition payload sent to the model on every `agent.generate()`
call. **Off by default.**

## Source / license

- Upstream: [`caveman`](https://github.com/JuliusBrussee/caveman) by Julius Brussee — `src/mcp-servers/caveman-shrink/compress.js`.
- License: **MIT**. Copyright (c) 2026 Julius Brussee. Full notice reproduced in the header of `src/atlas/caveman-shrink.ts` per the license's attribution requirement.
- What was ported: the `compress()` / `compressProse()` / `withProtectedSegments()` algorithm — the deterministic prose compressor only. The MCP stdio-proxy wrapper (`index.js`) was **not** ported — confirmed by direct read that it does not use `@modelcontextprotocol/sdk` (it's a generic newline-JSON transformer, not an MCP-schema-validated proxy), and ANUS doesn't run its own MCP server, so it doesn't apply here.
- Nothing else from the `caveman` repo was copied. No new npm dependency was added — the port is pure TypeScript, zero runtime deps.

## Exact seam

Proven (not assumed) by reading the live code before writing anything:

- ANUS does **not** run its own MCP server (`@modelcontextprotocol/sdk` is not a dependency; zero matches for `tools/list`/`ListToolsRequestSchema`/`McpServer` anywhere in `src/`). So there is no "MCP tools/list response" to intercept — the caveman-shrink concept had to be adapted from "MCP proxy" to "tool-dict description wrapper."
- `src/agent.ts` — the actual LIVE tool-wiring path (consumed by `cli.ts`, `swarm.ts`, `swarm-worker.ts`) — hand-lists tool objects directly and does **not** import `registry.ts`. `telegram.ts`'s CEO-chat agent builds its own `Agent` with **no tools at all**.
- `src/tools/registry.ts`'s `getToolDict()` — the "untracked registry path" the CTO brief explicitly named as a sanctioned seam — has **zero current importers** (verified via repo-wide grep). Wrapping its return value therefore touches **no live path**: no Telegram reply, no memory write, no shell content, no `policy.yaml`, no model output today.
- **Wired here:** `getToolDict()` now pipes its returned dict through `shrinkToolDict(dict, cavemanShrinkEnabled())` before returning (`src/tools/registry.ts`). `registry.ts` pre-existed in the working tree as uncommitted work (not authored this sprint); it is being committed for the first time because this package depends on it existing in version control. Its own tool-set logic is untouched — only the return value now passes through the optional compressor.

## Enable flag

`ATLAS_CAVEMAN_SHRINK` — unset / `0` / `false` = **disabled (default)**. `1` / `true` / `yes` = enabled. Read via `cavemanShrinkEnabled()` in `src/atlas/caveman-shrink.ts`.

## Fail-open + byte-identical-when-off (proven, not asserted)

- **Disabled:** `shrinkToolDict(tools, false)` returns the **exact same object reference** passed in — not a clone. Proven in `src/__tests__/caveman-shrink.test.ts` (`toBe(tools)`) and at the real wiring point in `src/__tests__/registry-shrink.test.ts` (`getToolDict('cli')` with the flag off produces descriptions `.toBe()`-identical to the un-shrunk tool exports).
- **Enabled + a per-tool failure:** the whole per-tool block (including reading `.description` itself, not just compressing it) is wrapped in `try/catch`; a failure falls back to that tool's original, unmodified object. Proven with a tool whose `description` getter deliberately throws — `shrinkToolDict` does not throw and returns the original tool unchanged.
- Only `.description` is ever touched. `inputSchema`/`outputSchema`/`execute` keep their original references (proven in tests) — so tool behavior, validation, and execution are unaffected regardless of the flag.

## A bug found and fixed during the port (documented for the record)

Upstream's sentinel-protection mechanism (which shields code fences, URLs, paths,
`CONST_CASE` identifiers, `dotted.method()` calls, and semver from compression)
delimits its placeholder tokens with **NUL bytes (`\0`)**, not spaces. Reading the
upstream file through a text viewer, NUL bytes render as invisible/blank and are
visually indistinguishable from a plain space — an earlier draft of this port
transcribed the delimiter as a literal space character. That silently broke
restoration whenever a protected segment ended a string, or sat next to
whitespace that `compressProse`'s own cleanup/`.trim()` collapsed away (e.g. a
URL at the end of a sentence lost its trailing sentinel space to `.trim()`, so
the restore regex never matched and the original URL was replaced by a bare
digit). Caught by the ported test fixtures (URL/path/CONST_CASE preservation
tests failed), root-caused via a byte-level dump of the real upstream file
(`\0${i}\0` / `/\0(\d+)\0/g`), and fixed by using the same NUL-delimited
sentinel upstream actually uses. All fixture tests pass after the fix.

## Measured reduction (non-secret fixture: ANUS's own 8 live tool descriptions)

```
shellTool:       273 -> 271 chars (0.7% reduction)
surfTool:        353 -> 340 chars (3.7% reduction)
grepTool:         76 ->  74 chars (2.6% reduction)
globTool:         58 ->  56 chars (3.4% reduction)
readFileTool:    176 -> 161 chars (8.5% reduction)
writeFileTool:   182 -> 171 chars (6.0% reduction)
listSkillsTool:   93 ->  91 chars (2.2% reduction)
loadSkillTool:    81 ->  75 chars (7.4% reduction)
TOTAL:          1292 -> 1239 chars (4.1% reduction)
```

**Honest calibration:** this is far below caveman's own headline "~65% output
compression." That number is measured on conversational LLM *output* (full
replies, with filler/pleasantries/hedging) — ANUS's tool descriptions are
already terse, technical strings with little of that to strip. The safety-critical
wording (`ATLAS_SHELL_ALLOW_DESTRUCTIVE=1`, `rm -rf /`, `disk format`, `shutdown`,
`pipe-to-shell`, `git reset --hard`) survives byte-for-byte in every case — proven
against the live `shellTool.description`, not a synthetic string (see tests).
The bigger win for this exact algorithm would likely be **conversational
prose** — e.g. a future compression pass over oversized memory/`CLAUDE.md`
files — not already-terse tool descriptions. That is a separate, unbuilt idea,
not part of this package.

## Rollback

Set `ATLAS_CAVEMAN_SHRINK=0` (or leave it unset — that's the default). No file
needs reverting; the flag alone restores byte-identical behavior, proven above.

## Tests

`src/__tests__/caveman-shrink.test.ts` — 10 fixtures ported (attributed) from
upstream's own test file plus 10 ANUS-specific fixtures (JSON-fragment
preservation, live safety-wording exactness, real reduction receipt, disabled-flag
identity, enabled-mode field isolation, fail-open on a throwing getter).
`src/__tests__/registry-shrink.test.ts` — 3 tests proving the real wiring point
(`registry.ts::getToolDict`) is byte-identical off and correctly shrinks on.
