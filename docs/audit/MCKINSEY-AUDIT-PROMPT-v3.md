# VOLAURA McKinsey-Grade Audit — v3

**For:** Claude Cowork (Opus 4.7)
**Commissioned by:** CEO Yusif Ganbarov
**Project age:** 28 days (2026-04-27)
**Mission:** Increase probability of project success. Every claim = tool-call receipt or silence.

---

## STEP 0 — GROUND (before anything)

```bash
# Check if node_modules exist before installing
ls apps/web/node_modules/.package-lock.json 2>/dev/null || pnpm install --frozen-lockfile 2>&1 | tail -5
pnpm typecheck 2>&1 | tail -10
cd apps/api && (test -f .venv/bin/activate && . .venv/bin/activate || test -f .venv/Scripts/activate && . .venv/Scripts/activate || true) && python -m pytest --tb=short 2>&1 | tail -20; cd ..
git log --oneline | head -30
find docs memory for-ceo -name "*.md" 2>/dev/null | wc -l
grep -q "^\.audit/$" .gitignore 2>/dev/null || echo ".audit/" >> .gitignore
curl -s https://volauraapi-production.up.railway.app/health
```

Save output to `.audit/2026-04-27/_baseline.md`.

**Cost estimate gate:** After Step 0, count total files to read across all 7 teams. Estimate token cost (input + output). If estimate > $30 — hard stop, report estimate, ask CEO. Proceed only under $30.

---

## TEAM STRUCTURE — 7 Teams + Devil's Advocate, Sequential

Run teams in this order. Each = one Agent (Sonnet-grade).

### T1 — Strategy & Positioning (run FIRST — frames everything)

**Budget:** ≤2000 tokens output.

**Read:** `docs/ECOSYSTEM-CONSTITUTION.md`, `memory/atlas/project_v0laura_vision.md`, `memory/ceo/02-vision.md`, `memory/atlas/company-state.md`
**WebSearch:** "skills verification platform 2026", "Mercor vs Karat vs Triplebyte", "Azerbaijan HR tech market"

**Answer:**
- Is "Prove your skills. Earn your AURA." defensible in 2026? Who else does this?
- TAM/SAM/SOM for AZ + Turkey + Georgia + Kazakhstan
- Who is the ICP? Event volunteers or HR departments?
- What's the moat if LinkedIn adds skills verification?

### T2 — Risk, Legal & Security (run SECOND — blocks launch)

**Budget:** ≤2500 tokens output.

**Read:** last 10 files in `supabase/migrations/`, `apps/api/app/config.py` (search for RISK-* comments), `memory/atlas/company-state.md`, `memory/atlas/atlas-debts-to-ceo.md`
**Run:** `grep -r "RLS" supabase/migrations/ | wc -l`, `grep -r "on_auth_user_created" supabase/migrations/`

**Answer:**
- GDPR Art. 22 consent flow: exists in code or paper only?
- ITIN/EIN/83(b) deadlines — what's overdue?
- RLS coverage: any public table without policy?
- Profile creation trigger: working or 68% failure?
- Sentry: receiving events or silent?
- Dead API keys: which providers are down?

### T3 — Tech, Architecture & Ecosystem (merged T3+T9)

**Budget:** ≤3500 tokens output (expanded scope: architecture + swarm 31K LOC + ecosystem coherence).

**Read:** list all files in `apps/api/app/routers/`, list all `page.tsx` in `apps/web/src/app/[locale]/`, key modules in `packages/swarm/` (read `engine.py` first 80 lines, `autonomous_run.py` first 50 lines, `orchestrator.py` first 50 lines), list all `.yml` in `.github/workflows/`
**Run:** Use Step 0 typecheck/test output. `grep -c "def " apps/api/app/routers/*.py` for endpoint count.

**Answer:**
- Code health: typecheck clean? Tests passing? Build time?
- LLM fallback chain: Vertex → Gemini → Groq → OpenAI — all 4 wired and callable?
- Cross-product integration: `character_events` bus firing across 5 faces? Single Supabase auth?
- Swarm: 31K LOC Python — daemon running or dormant? `perspective_weights.json` real or default zeros? `shared_memory.db` exists?
- Monorepo: Vercel + Railway deploy pipeline healthy? Last successful deploy?
- GitHub Actions: how many active vs disabled workflows? Why disabled?
- Node 20, Python 3.11, pnpm 10.32 — all current?

### T4 — Product, UX & Brand (merged T2+T8)

**Budget:** ≤2000 tokens output.

**Read:** `apps/web/src/app/globals.css` (design tokens, animation durations), `docs/ECOSYSTEM-CONSTITUTION.md` (5 Foundation Laws + 8 Crystal Laws), `memory/atlas/voice.md`, list files in `apps/web/src/locales/`
**Run:** `grep -rn "#FF0000\|#DC2626\|#EF4444\|red-500\|red-600" apps/web/src/`, `grep -rn "duration.*[0-9][0-9][0-9][0-9]" apps/web/src/` (4+ digit ms = potential >999ms violation)

**Answer:**
- Foundation Laws 1-5: enforced in CSS design tokens or aspirational?
- Leaderboard page: still routable in production? (Crystal Law 5 / G9 violation)
- Badge timing: shown immediately post-assessment? (Crystal Law 6 Amendment violation)
- i18n: AZ + EN at parity? Translation line counts?
- Mobile-first: responsive breakpoints in layout? Bottom nav on mobile?
- Voice: CEO-facing output = Russian storytelling? Machine docs = structured?

### T5 — Capital, Runway & AI Economics

**Budget:** ≤2000 tokens output.

**Read:** `memory/atlas/company-state.md`, `.env.example`, `memory/ceo/13-financial-context.md`
**Run:** `cat .env 2>/dev/null | grep -E "^[A-Z]" | sed 's/=.*//'` (key names only — NEVER output values)

**Answer:**
- Monthly burn: LLM + Vercel + Railway + Supabase — actual dollar figures?
- Credits claimed vs verified: AWS Activate, GCP Startups, NVIDIA Inception, Stripe Atlas perks
- Dead keys: which providers exhausted credits? Cost to replace?
- Token cost model: 5 providers × estimated usage → monthly projection
- Grant pipeline: GITA $240K, KOSGEB $50K — status, deadlines, blockers?
- Open debt: 460 AZN to CEO — documented path to closure?

### T6 — Operations, Velocity & Performance (merged T7+T10)

**Budget:** ≤2500 tokens output.

**Read:** `memory/atlas/lessons.md` (FULL — all 26 error classes), `memory/swarm/SHIPPED.md` (first 200 lines), `memory/atlas/journal.md` (last 30 entries), `memory/atlas/heartbeat.md` (last session state)
**Run:** `git log --oneline | wc -l`, `find . -name "*.md" -not -path "./.git/*" -not -path "./node_modules/*" | wc -l`, `git log --oneline --since="2026-04-20" | wc -l`

**Answer:**
- Sprint velocity: commits/day over last 7 days? Features shipped vs declared in SHIPPED.md?
- Doc proliferation: total .md files? Ratio to source files? How many are stale/orphaned?
- 19 P0 pre-launch blockers — who owns each? Which are CEO-blocked vs Atlas-blocked?
- Decisions with no owner?

**Mandatory subsection A — Atlas Protocol Violations:**
- Top 5 error classes by frequency from `lessons.md` (cite class number + line ref)
- Which classes were triggered in last 7 days? Which are dormant?
- Sonnet-for-hands compliance: evidence of Opus doing hands-work or Sonnet doing synthesis?

**Mandatory subsection B — CEO Decision Patterns (data only, no judgment):**
- From `memory/atlas/journal.md` + `memory/ceo/06-decision-patterns.md`: 3-5 observable patterns
- What's blocked waiting for CEO action? (list with dates)
- Delegation gaps: tasks CEO holds that tools could execute?

### T7 — Growth & GTM (run LAST — depends on all above)

**Budget:** ≤2000 tokens output.

**Read:** auth-related pages in `apps/web/src/app/[locale]/(auth)/`, public pages in `apps/web/src/app/[locale]/(public)/`, `memory/atlas/CURRENT-SPRINT.md` (Track G: launch status)
**Run:** Supabase MCP `execute_sql` if available: `SELECT count(*) FROM auth.users` and `SELECT count(*) FROM public.profiles`

**Answer:**
- Funnel: cold → signup → assessment → AURA → org match. Where does it break?
- Users: total real (non-test)? Returning? Last signup date?
- Viral loop: AURA badge sharing implemented?
- AZ-specific: landing/content for Azerbaijan market?
- Email: Resend configured and sending?
- Launch trigger: CEO strategic decision pending — what data would inform it?

---

## FINDING FORMAT — 4 Fields

```
FINDING: [one line]
EVIDENCE: [tool-call receipt — file:line, command output, query result]
ACTION: [verb: write/delete/refactor/ship/migrate/sign/file/pay/cancel/replace/kill + file path + owner + deadline]
COST: [hours + dollars if >$1]
```

No "consider", "explore", "think about", "improve". Action verbs only.

---

## GATES — Every Finding

**Gate 1 — AGE:** 28-day project. Benchmark against day-28 startups, not mature companies.
**Gate 2 — ATTRIBUTION:** Whose default caused this? (CEO / Atlas / training-bias / missing-rule / external)
**Gate 3 — CREDIT:** Who caught existing fixes? Atlas-narrated ≠ Atlas-discovered. CEO catches count as CEO credit.

Finding without all 3 gates = dropped.

---

## DELIVERABLES — 3 + 1

### A) Team Reports
`.audit/2026-04-27/T1-strategy.md` through `T7-growth.md`
Findings only, no preamble. Token limits per team as specified above.

### B) Synthesis + Prioritized Action List
`.audit/2026-04-27/SYNTHESIS.md`
Top 10 findings ranked by Impact × (1/Effort). Each: owner + deadline + cost. ≤3000 tokens.

### C) CEO Brief (Russian, storytelling)
`for-ceo/briefs/2026-04-27-mckinsey-audit.md`
Per `memory/atlas/voice.md`: short paragraphs, no bullets, no tables, no bold-spam. ≤5 paragraphs. One topic per paragraph. Append card entry to `for-ceo/index.html`.

### D) Devil's Advocate (external model)
After all 7 teams + synthesis complete:

```bash
# Collect all findings into one file
cat .audit/2026-04-27/SYNTHESIS.md > /tmp/audit-for-review.md

# REDACT secrets before sending to external model — provider-specific patterns only,
# NOT a blanket alphanumeric scrubber (that would corrupt file paths, function names,
# commit SHAs, and table names, leaving Devil's Advocate with a starred synthesis).
sed -i \
  -e 's/sk-proj-[A-Za-z0-9_-]\{40,\}/sk-proj-***REDACTED***/g' \
  -e 's/sk-ant-[A-Za-z0-9_-]\{40,\}/sk-ant-***REDACTED***/g' \
  -e 's/sk-or-[A-Za-z0-9_-]\{40,\}/sk-or-***REDACTED***/g' \
  -e 's/gsk_[A-Za-z0-9_-]\{40,\}/gsk_***REDACTED***/g' \
  -e 's/AIzaSy[A-Za-z0-9_-]\{30,\}/AIzaSy***REDACTED***/g' \
  -e 's/sb_secret_[A-Za-z0-9_-]\{30,\}/sb_secret_***REDACTED***/g' \
  -e 's/sb_publishable_[A-Za-z0-9_-]\{30,\}/sb_publishable_***REDACTED***/g' \
  -e 's/xoxb-[A-Za-z0-9_-]\{20,\}/xoxb-***REDACTED***/g' \
  -e 's/glpat-[A-Za-z0-9_-]\{20,\}/glpat-***REDACTED***/g' \
  -e 's/ghp_[A-Za-z0-9_-]\{36\}/ghp_***REDACTED***/g' \
  -e 's/[0-9]\{7,12\}:[A-Za-z0-9_-]\{30,\}/***TELEGRAM_TOKEN***/g' \
  /tmp/audit-for-review.md
```

Call **Gemini 2.5 Pro** (primary, via `GEMINI_API_KEY` from `apps/api/.env`) or **Cerebras Qwen3-235B** (fallback, via `CEREBRAS_API_KEY`):

Prompt to external model: "You are reviewing a startup audit. Read the synthesis below. Find the 3 weakest claims — where evidence is thin, logic is circular, or the recommendation doesn't follow from the finding. For each: quote the claim, explain why it's weak, suggest what would make it strong. Be adversarial, not helpful."

Save response to `.audit/2026-04-27/devils-advocate-external.md`.

**Fallback:** If both Gemini and Cerebras unavailable, run as Claude self-review with system prompt: "Assume you share the auditor's blind spots. What would a hostile VC due-diligence team challenge?"

---

## HARD RULES

1. **Secrets:** NEVER output API keys, tokens, passwords in ANY file. Redact to first 4 chars + `***`. Applies to tool-call receipts quoted in findings.
2. **Money-aware:** Recommendation with cost >$1 declares cost upfront with pricing source.
3. **Arsenal-first:** Before "CEO needs to do X" — check if any tool/credential/MCP available. If yes, execute, don't delegate to CEO.
4. **Memory-first:** Before any claim — check `memory/atlas/company-state.md`, `memory/swarm/SHIPPED.md`, `for-ceo/reference/*`. Contradicting canon needs explicit evidence.
5. **UTF-8:** AZ characters preserved: ə ğ ı ö ü ş ç.
6. **No hedging:** "I think" / "probably" / "might" = replace with tool-call receipt or delete.
7. **Token budget:** T1 ≤2000, T2 ≤2500, T3 ≤3500, T4 ≤2000, T5 ≤2000, T6 ≤2500, T7 ≤2000. Synthesis ≤3000. CEO brief ≤1500. Total target: ~350K tokens input+output.
8. **Cost gate:** After Step 0, estimate total session cost. If >$30, hard stop and report.

---

## BEGIN

Run Step 0. Save baseline. Estimate cost. If under $30 → T1 through T7 in order → Synthesis → CEO Brief → Devil's Advocate external call.
