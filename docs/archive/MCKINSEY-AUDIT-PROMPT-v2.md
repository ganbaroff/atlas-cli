# VOLAURA McKinsey-Grade Audit — v2

**For:** Claude Cowork (Opus 4.7)
**Commissioned by:** CEO Yusif Ganbarov
**Project age:** 28 days (2026-04-27)
**Mission:** Increase probability of project success. Every claim = tool-call receipt or silence.

---

## STEP 0 — GROUND (before anything)

Run in order, save output to `.audit/baseline.md`:

```bash
pnpm install --frozen-lockfile 2>&1 | tail -5
pnpm typecheck 2>&1 | tail -10
cd apps/api && python -m pytest --tb=short 2>&1 | tail -20; cd ..
git log --oneline | head -30
find docs memory for-ceo -name "*.md" 2>/dev/null | wc -l
curl -s https://volauraapi-production.up.railway.app/health
```

Add `.audit/` to `.gitignore` BEFORE writing any files. All audit output goes to `.audit/2026-04-27/`.

---

## TEAM STRUCTURE — 7 Teams, Sequential Priority Order

Run teams in this order (each = one Agent, Sonnet-grade). Max 2000 tokens output per team.

### T1 — Strategy & Positioning (run FIRST — frames everything)

**Read:** `docs/ECOSYSTEM-CONSTITUTION.md`, `memory/atlas/project_v0laura_vision.md`, `memory/ceo/02-vision.md`, `memory/atlas/company-state.md`
**WebSearch:** "skills verification platform 2026", "Mercor vs Karat vs Triplebyte", "Azerbaijan HR tech market"

**Answer:**
- Is "Prove your skills. Earn your AURA." defensible in 2026? Who else does this?
- TAM/SAM/SOM for AZ + Turkey + Georgia + Kazakhstan
- Who is the ICP? Event volunteers or HR departments?
- What's the moat if LinkedIn adds skills verification?

### T2 — Risk, Legal & Security (run SECOND — blocks launch)

**Read:** `supabase/migrations/` (last 10), `apps/api/app/config.py` (RISK-* comments), `memory/atlas/company-state.md`, `memory/atlas/atlas-debts-to-ceo.md`
**Run:** `grep -r "RLS" supabase/migrations/ | wc -l`, check auth trigger on profiles table

**Answer:**
- GDPR Art. 22 consent flow: exists in code or paper only?
- ITIN/EIN/83(b) deadlines — what's overdue?
- RLS coverage: any public table without policy?
- Profile creation trigger: working or 68% failure?
- Sentry: receiving events or silent?
- Dead API keys: which providers are down?

### T3 — Tech, Architecture & Ecosystem (merged T3+T9)

**Read:** `apps/api/app/routers/` (list all), `apps/web/src/app/[locale]/` (list routes), `packages/swarm/` (key modules), `.github/workflows/` (list active vs disabled)
**Run:** Use Step 0 output for typecheck/test results

**Answer:**
- Code health: typecheck clean? Tests passing? Build time?
- LLM fallback chain: 4 providers actually wired or just declared?
- Cross-product integration: character_events bus firing? Single auth across products?
- Swarm: 31K LOC — running in production or dormant?
- Monorepo: Vercel + Railway deploy pipeline healthy?
- Node version, Python version, dependency freshness

### T4 — Product, UX & Brand (merged T2+T8)

**Read:** `apps/web/src/app/globals.css` (design tokens), `docs/ECOSYSTEM-CONSTITUTION.md` (5 Foundation Laws), `memory/atlas/voice.md`, `apps/web/src/locales/`
**Run:** `grep -r "#FF0000\|#DC2626\|#EF4444" apps/web/src/` (red color violations), `grep -r "duration.*2000" apps/web/src/` (animation violations)

**Answer:**
- Foundation Laws 1-5: enforced in code or aspirational?
- Leaderboard: still in production? (Crystal Law 5 violation)
- Badge timing: shown immediately post-assessment? (Crystal Law 6 violation)
- i18n: both AZ+EN at parity?
- Mobile-first: responsive evidence?
- Voice consistency: CEO-facing = Russian storytelling, machine-facing = structured?

### T5 — Capital, Runway & AI Economics (merged T5 + new Data/AI)

**Read:** `memory/atlas/company-state.md`, `.env.example` (provider list), `memory/ceo/13-financial-context.md`
**Run:** `cat .env | grep -E "^[A-Z]" | sed 's/=.*//'` (list keys, NOT values — never output secrets)

**Answer:**
- Monthly burn: LLM costs, Vercel, Railway, Supabase — actual $?
- Credits in hand: AWS Activate, GCP, NVIDIA Inception — claimed vs verified?
- Dead keys: which providers exhausted? Cost of replacing?
- Token cost model: 5 providers × usage pattern → monthly projection
- Grant pipeline: GITA $240K, KOSGEB $50K — status and deadlines?
- Open debt: 460 AZN to CEO — repayment path?

### T6 — Operations & Founder Velocity (merged T7+T10)

**Read:** `memory/atlas/lessons.md`, `memory/swarm/SHIPPED.md` (first 200 lines), `memory/atlas/journal.md` (last 30 entries)
**Run:** `git log --oneline | wc -l`, `find . -name "*.md" -not -path "./.git/*" -not -path "./node_modules/*" | wc -l`

**Answer:**
- Sprint velocity: commits/day, features shipped vs declared?
- Doc proliferation: how many .md files? Ratio of docs to source files?
- Atlas protocol violations: top 3 error classes by frequency?
- CEO bottlenecks: what's blocked waiting for CEO action?
- Decisions pending: what has no owner?
- 19 P0 pre-launch blockers — who owns each?

### T7 — Growth & GTM (run LAST — depends on all above)

**Read:** `apps/web/src/app/[locale]/(auth)/` (signup flow), `apps/web/src/app/[locale]/(public)/` (landing), `memory/atlas/CURRENT-SPRINT.md` (Track G launch status)
**Run:** Check Supabase auth.users count if MCP available

**Answer:**
- Funnel: cold → signup → assessment → AURA score → org match. Where does it break?
- Current users: how many real (non-test)? Returning users?
- Viral loop: does sharing AURA badge exist?
- AZ-first strategy: is there content/landing for AZ market specifically?
- Email lifecycle: Resend configured? Actually sending?
- What's the launch trigger? CEO decision pending?

---

## FINDING FORMAT — 4 Fields Only

```
FINDING: [one line]
EVIDENCE: [tool-call receipt — file:line, command output, query result]
ACTION: [exact verb — write/delete/refactor/ship/file/pay + file path + owner + deadline]
COST: [hours estimate + dollar cost if any]
```

No "consider", "explore", "think about". Verbs: write, delete, refactor, ship, migrate, sign, file, pay, cancel, replace, kill.

---

## GATES — Applied to Every Finding

**Gate 1 — AGE:** 28-day project. Benchmark against startups at day 28, not Google at year 10.
**Gate 2 — ATTRIBUTION:** Whose default behavior caused this? CEO, Atlas, training-bias, missing rule? Name it.
**Gate 3 — CREDIT:** Who fixed existing fixes? Don't claim Atlas-narrated catches as Atlas-discovered.

Finding without all 3 gates answered = finding dropped.

---

## DELIVERABLES — 3 Total

### A) Team Reports (7 files)
`.audit/2026-04-27/T1-strategy.md` through `T7-growth.md`
Each ≤2000 tokens. Findings only, no preamble.

### B) Synthesis + Action List
`.audit/2026-04-27/SYNTHESIS.md`
Top 10 findings ranked by Impact × (1/Effort). Each with owner + deadline. ≤3000 tokens.

### C) CEO Brief (Russian, storytelling)
`.audit/2026-04-27/CEO-BRIEF.md`
Per `memory/atlas/voice.md`: short paragraphs, no bullets, no tables, no bold-spam. ≤5 paragraphs. One topic per paragraph. This is what Yusif reads. Everything else is appendix.

---

## DEVIL'S ADVOCATE PASS

After all 7 teams report, run ONE separate agent with system prompt:
"Read all 7 team reports. Find the 3 weakest claims. For each: quote the claim, explain why it's wrong or overstated, provide counter-evidence."

Save to `.audit/2026-04-27/devils-advocate.md`. This replaces per-finding adversarial counters.

---

## HARD RULES

1. **Secrets:** NEVER output API keys, tokens, passwords. Redact to first 4 chars + `***`. If a tool call returns secrets, redact in the finding.
2. **Money:** Any recommendation with cost >$1 declares the cost upfront with source.
3. **Arsenal-first:** Before writing "CEO needs to do X" — check if any tool/credential/MCP can do it without CEO. If yes, do it.
4. **Memory-first:** Before any claim — check `memory/atlas/company-state.md`, `memory/swarm/SHIPPED.md`, `for-ceo/reference/*`. Contradicting existing canon requires explicit evidence of why canon is outdated.
5. **UTF-8 everywhere.** AZ characters preserved: ə ğ ı ö ü ş ç.
6. **No "I think" or "probably."** Tool-call receipt or silence.
7. **Budget:** Each team ≤2000 tokens output. Synthesis ≤3000. CEO brief ≤1500. Total target: ~300K tokens.

---

## BEGIN

Read `.audit/` gitignore status. Run Step 0. Save baseline. Then T1 through T7 in order.
