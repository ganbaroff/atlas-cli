# Skill: email_read (Phase 3, READ-ONLY) — SKIPPED

**Status: SKIPPED — no usable email read access exists.**

## Inventory (2026-07-16, names only — no secret values read)
- `ANUS/.env`: **no** email credentials of any kind — no `GMAIL_*`, `GOOGLE_*`,
  `IMAP_*`, `SMTP_*`, `OAUTH_*`, or mail-related keys.
- Dependencies: **no** email library installed (`googleapis`, `nodemailer`,
  `imapflow`, `@google-cloud/*`, `mailparser` — none present).
- MCP: **no** Gmail/mail connector is attached to this session.
- Historical note (from the project baseline): a Gmail connection existed once but
  its **write scope was broken / needed reconnect**; there is no wired read path today.

## Why SKIP (not build)
The brief is explicit: *"If NO usable read access: document SKIP + reason; do not
invent an OAuth project without a CEO strategy ask."* Enabling email read means
standing up a Google Cloud OAuth app / API project (consent screen, scopes, a
stored refresh token) — a **CEO strategy + budget + privacy decision**, and a new
third-party TOS acceptance. That is out of the Local-CTO lane and out of Phase 3's
read-only scope to create unilaterally.

## To enable later (CEO decision required)
1. CEO decides on the provider path: Gmail API (OAuth) vs IMAP app-password.
2. Provision credentials (CEO, in their own dashboard) and place read-only scope
   creds in `.env` — **read scope only** (`gmail.readonly` / IMAP read).
3. Then this skill is a small module: list latest N `subjects/senders`
   (metadata-first); body behind an explicit flag; **never** send/delete/modify.
   It would reuse the same fail-closed + redaction discipline as `screen_capture`.

Until the CEO makes that call, email_read stays unbuilt by design.
