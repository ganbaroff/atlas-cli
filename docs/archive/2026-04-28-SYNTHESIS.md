# VOLAURA Audit Synthesis — 2026-04-28

7 teams, tool-verified findings. Ranked by Impact × (1/Effort).

## TOP 10 FINDINGS

### 1. Profile creation trigger missing — P0
**Impact:** Critical (Revenue) | **Effort:** S (20 lines SQL)
No `on_auth_user_created → profiles` trigger. 68% of signups get empty dashboard. Live user xaqanimom confirmed broken.
**Owner:** Atlas | **Deadline:** Before any launch
**Source:** T2

### 2. CEO holding 5 admin clicks for 1-9 days — P0
**Impact:** Critical (Velocity) | **Effort:** S (15 min total)
Google OAuth (9d), Groq limit (7d), ASAN visit, Stripe Perks, Resend key. Each 2-5 min. All block downstream.
**Owner:** CEO | **Deadline:** This week
**Source:** T6

### 3. Signup gate closed — P0
**Impact:** Critical (Revenue) | **Effort:** S (1 env var)
`OPEN_SIGNUP=false` on Railway. Organic visitors (xaqanimom) bouncing. Invite codes not distributed.
**Owner:** CEO decision | **Deadline:** Before launch date
**Source:** T7

### 4. G38 DeCE "Moment of Truth" not built — P0
**Impact:** Critical (Revenue/Moat) | **Effort:** M (~40h)
The ONLY differentiation vs LinkedIn Verified Skills. Without behavioral evidence in org discovery, VOLAURA = another badge platform.
**Owner:** Atlas | **Deadline:** Before B2B Tier 3 launch
**Source:** T1

### 5. Crystal Law 6 violated — badge shown post-assessment — P1
**Impact:** High (Trust) | **Effort:** S (~8h)
Assessment → immediate badge reveal. Constitution says defer to next AURA visit (4h+ surprise discovery). Code exists, just wrong sequencing.
**Owner:** Atlas | **Deadline:** Before launch
**Source:** T4

### 6. Sentry silent — 0 events in 30 days — P1
**Impact:** High (Risk) | **Effort:** S (verify env var)
DSN defaults to empty string. Possible: env var not set on Railway. Zero error visibility in production.
**Owner:** Atlas (verify) / CEO (Railway env) | **Deadline:** Before launch
**Source:** T2

### 7. Email lifecycle dead — Resend key not set — P1
**Impact:** High (Growth) | **Effort:** S (15 min CEO setup)
`send_aura_ready_email` and `send_ghosting_grace_email` both coded and wired. No-op because `RESEND_API_KEY=""`.
**Owner:** CEO | **Deadline:** This week
**Source:** T7

### 8. ITIN deadline May 15 — ASAN visit not done — P0-legal
**Impact:** Critical (Legal) | **Effort:** S (CEO physical, 1 day)
Without ITIN: no tax ID → no bank → no revenue. ASAN certified passport copy is $20-30 AZN path. Not started.
**Owner:** CEO | **Deadline:** This week
**Source:** T2

### 9. Anthropic API spend cap not set — P1
**Impact:** High (Capital) | **Effort:** S (5 min)
Server-side Claude calls uncapped. First real traffic hitting Sonnet fallback → surprise $90+/day bills. Dashboard cap = $20/mo.
**Owner:** CEO (Anthropic dashboard) | **Deadline:** Before launch
**Source:** T5

### 10. 4277 .md files — doc proliferation — P2
**Impact:** Medium (Velocity) | **Effort:** M (archive pass)
1:4 ratio md:source. 2635 in .claude/ alone. Class 18 (grenade-launcher) still active. New Atlas instances wake into noise.
**Owner:** Atlas | **Deadline:** Sprint 2
**Source:** T6

## VELOCITY SNAPSHOT
- 2518 commits / 28 days = 89.9/day (decelerating: 39.4/day last 7 days)
- Real feature commits ~24/day (38% is cron/heartbeat noise)
- 4/5 Foundation Laws enforced in code
- Top Atlas violations: Class 3 (solo, 6x), Class 7 (false completion, 5x), Class 10 (theatre, 4x)
- Monthly burn: $207. Runway: CEO personal funds only until Mercury opens.

## FINANCIAL SNAPSHOT
- Burn: $207/mo | Confirmed credits: $2,800 | Pending credits: ~$405K
- Grants EV: ~$23K weighted | GITA deadline: May 27 (30 days)
- Open debt: 460 AZN ($270) | Total sunk: ~$1,175
- Zero revenue. Zero payment integration live.
