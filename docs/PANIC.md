# Atlas PANIC runbook — how to stop it fast

Two levers, fastest first.

## 1. Telegram `/pause` (instant, process-local)
Send **`/pause`** to the bot (CEO-only — the inbound-auth middleware drops
everyone else). It sets `ATLAS_PAUSE=1` inside the running bot process.

**What it stops:** all autonomy — the autonomous brain-loop, swarm decompose,
and the `/task` subprocess spawner (`task-spawner.runTask` returns `blocked`
while paused).

**What it does NOT stop:** a redeploy resets it (it lives only in the running
process's env). And it does not tear down the HTTP bot process itself — normal
CEO chat still works. For a hard stop that survives redeploy, use lever 2.

Lift it with **`/resume`**.

## 2. Railway env var `ATLAS_PAUSE=1` (durable)
In the Railway dashboard → the Atlas bot service → **Variables**, set
`ATLAS_PAUSE=1` and redeploy (or let it restart). This survives redeploys and is
the authoritative pause. `isPaused()` reads it live.

If `/resume` says *"probably ATLAS_PAUSE is set on Railway"*, that means the
durable var is still `1` — clear it in the dashboard, not just in chat.

## 3. Hard stop the whole bot (last resort)
Railway dashboard → the service → **Remove/Stop deployment** (do NOT delete the
service or its volume). The `/health` endpoint will stop returning 200 and
Railway's restart policy (`ON_FAILURE`, max 5) will not resurrect a manual stop.
Re-deploy with `railway up --detach` to bring it back.

## Related spend brakes (already always-on)
- `ATLAS_ALLOW_PAID` unset ⇒ paid providers (openai/openrouter/anthropic) refuse.
- Over `ATLAS_DAILY_TOKEN_CAP` (default 500k) ⇒ paid hard-blocked, free warn-once.
- `ATLAS_BRAIN_QUEUE_CAP` (default 20/day) ⇒ caps autonomous queue seeds.

## Health check after any panic action
```
curl -s https://fantastic-generosity-production-df90.up.railway.app/health
```
Expect `{"status":"ok",...}` HTTP 200 unless you did lever 3 on purpose.

See **[POLICY.md](POLICY.md)** for the full policy surface.
