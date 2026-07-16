# Skill: screen_capture (Phase 3, READ-ONLY)

Captures the **primary display** to a PNG under a safe temp dir, with an optional,
opt-in, capped, secret-redacted **vision summary**. No mouse/keyboard control —
this skill only reads pixels.

Code: `src/atlas/screen-capture.ts` · capture helper `apps/desktop/capture-screen.ps1` · CLI `atlas capture`.

## Use
```
node dist/cli.js capture               # capture only -> PNG + thumb in temp
node dist/cli.js capture --summarize   # + optional vision summary (opt-in, capped)
```
Output dir: `%TEMP%\atlas-captures\` (override `ATLAS_CAPTURE_DIR`). Never writes to the Desktop.

## Vision summary — opt-in, cheap, capped, redacted
- **Off by default.** Enable with `ATLAS_SCREEN_VISION=1` or `policy.skills.screen.vision_enabled: true`.
- **Credits-before-cash:** uses the free **freellmapi** gateway (gemini-2.5-flash). Gated through `enforceSpendPolicy`.
- **Hard cap:** `policy.skills.screen.max_per_hour` (default 12) / `ATLAS_SCREEN_MAX_PER_HOUR`, enforced by a cross-process rate file.
- **Secret-safe:** the summary is run through `redactSecrets()` (OpenAI/Google/GitHub/Slack keys, bearer tokens, JWTs, `key=value`) before it is returned or logged. The freellmapi endpoint host is never printed.
- **Fail-closed:** disabled / missing creds / over cap / provider error → summary skipped with a reason; the capture still returns.
- Verified 2026-07-16: benign test image → freellmapi/gemini-2.5-flash → redacted summary, rate slot consumed. Only a downscaled JPEG thumb is sent — and only when you opt in.

## ⚠️ Antivirus gate on live capture (this machine)
On 2026-07-16 the native capture (`Graphics.CopyFromScreen`) was **blocked by
Windows Defender/AMSI**: *"This script contains malicious content and has been
blocked by your antivirus software."* Screen-grab is a spyware-shaped behavior, so
Defender's heuristic flags scripted `CopyFromScreen`.

This is **not evaded** — the security software is doing its job, and turning it off
or obfuscating the script is out of scope. To use live capture on this machine, the
**CEO** makes a conscious choice:
- Add a Defender **exclusion** for `apps/desktop/capture-screen.ps1` (your machine, your call), or
- Run the capability from a signed/trusted binary, or
- Rely on the sanctioned agent screenshot path (computer-use) for agent-driven captures.

Until then, `atlas capture` **fails closed** with the AV error — no silent workaround.
The vision-summary pipeline, redaction, rate-cap, and CLI are all code-complete and
unit-tested independently of the capture step.

## Boundaries
- READ-ONLY. No mouse/keyboard/RPA. No delete.
- Windows only (primary display).
- Does not auto-send anywhere; the CEO's real screen is only sent to freellmapi if
  you explicitly `--summarize` with vision enabled.

## Tests
`src/__tests__/screen-capture.test.ts` — redaction shapes, key=value redaction, and
the hourly rate cap (allow-to-cap-then-deny).
