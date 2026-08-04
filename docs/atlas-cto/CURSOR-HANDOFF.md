# Cursor Handoff

> Standing end-of-session ritual. This file is replaced each session, not appended to. Written by the Cursor seat after Integronix source reconciliation (read-only).

## 1. Date, branch, HEAD

- Date: 2026-08-05
- Branch: `codex/atlas-cost-router-design`
- HEAD before this handoff commit: `0f5eb00` — `chore: cursor handoff`

```
$ git log -1 --oneline
0f5eb00 chore: cursor handoff

$ git branch --show-current
codex/atlas-cost-router-design
```

## 2. Files changed this session (one line each)

ANUS repo (committed this session — handoff only):

- `docs/atlas-cto/CURSOR-HANDOFF.md` — replace with Integronix source-reconciliation gate results (read-only; no code changes).

Outside ANUS (evidence only; not in this git commit):

- `C:\Users\user\.atlas\quarantine\evidence\integronix-source-reconciliation-2026-08-05\LOCAL-MANIFEST-DEPLOY-V2.json` — SHA-256 manifest for archive deploy-v2 (182 files).
- `...\LOCAL-MANIFEST-SOURCE-DEPLOY.json` — SHA-256 manifest for archive source/deploy (116 files).
- `...\LIVE-MANIFEST.json` — public crawl routes/assets/products/SEO.
- `...\CLOUDFLARE-AUTHORITY.json` — Pages deployments + D1 schema/counts (no secrets/values).
- `...\DRIFT-REPORT.json` — live vs deploy-v2 vs source/deploy classifications.
- `...\SOURCE-RECONCILIATION-REPORT.md` — full gate report.
- `...\RECEIPT.md` — session receipt.

**Not modified:** `C:\Projects\_archive\integronix-audit\deploy-v2\`, `...\source\deploy\`, production, DNS, D1 rows.

## 3. Real test/command output

```
$ npx wrangler pages project list
│ Project Name │ Project Domains                                        │ Git Provider │ Last Modified │
│ integronix   │ integronix.pages.dev, integronix.az, www.integronix.az │ No           │ 3 weeks ago   │

$ npx wrangler pages deployment list --project-name=integronix --json
(current Production entry)
{"Id":"a116b17e-079b-4c57-b743-9d477b898d15","Environment":"Production","Branch":"main",
 "Deployment":"https://a116b17e.integronix.pages.dev","Status":"3 weeks ago"}

$ npx wrangler d1 execute integronix --remote --command "SELECT ... COUNT(*) ..."
"t":"categories","n":5
"t":"products","n":68
"t":"product_images","n":58
"t":"product_docs","n":0
"t":"product_specs","n":20
"t":"redirects","n":0
"t":"pub","pub_ru":68,"pub_az":0,"pub_en":0

Local manifests:
deploy-v2 fileCount=182 totalBytes=15347958 functions=34
source/deploy fileCount=116 totalBytes=14739471

Drift (hash-proven):
a116MatchesDeployV2=False
faffMatchesSourceDeploy=True
homepage: LIVE_DIFFERS_FROM_DEPLOY_V2
care/services/company: live == source/deploy, != deploy-v2
css/js/favicon/sitemap: LIVE_MATCHES_DEPLOY_V2
/ru/ /en/ hubs: 404; /az/: 200; EN catalogs: 404
```

## 4. Known risks and broken items

- No verified Integronix Git repository / production commit exists.
- `deploy-v2` is **not** byte-identical to production tip `a116b17e`.
- Local `deploy-v2` marketing pages (care/services/company) are **ahead of** what production still serves (prod still matches `source/deploy` for those).
- `deploy-v2/en/*` exists locally but production `/en/` and `/en/index.html` return **404**.
- Catalog/product HTML is D1-generated; D1 rows were not exported (by design).
- Wrangler CLI has **no** pages deployment rollback subcommand; dashboard restore **untested**.
- Junk must not enter Git: `functions/deploy_output.log.js`, `functions/wrangler.toml.js`, `.wrangler/`, secrets shells.
- Cloudflare-managed robots preamble and email-protection bytes are live-only edge artifacts.

## 5. Next three steps

1. CEO decides whether to approve creating a **new** Integronix Git canon path (outside archive) per `RECONSTRUCT_CANON_FROM_DEPLOY_V2_AND_LIVE`.
2. If approved: seed repo from `deploy-v2` minus junk/secrets; pin `a116b17e-079b-4c57-b743-9d477b898d15` + evidence hashes; keep D1 external; decide whether first commit keeps local-ahead HTML or aligns to prod tip.
3. Before any deploy: prove dashboard restore of a prior deployment ID in a non-destructive dry-run / CEO-watched restore test; do not ship Proof Pack until canon + rollback gates PASS.

## 6. Blockers requiring CEO or orchestrator decision

- **Approve or reject** creating Integronix Git canon (`NEEDS_APPROVAL` now).
- **Choose alignment policy:** keep local-ahead `deploy-v2` HTML vs reset selected pages to match `a116b17e` / `source/deploy` where prod still matches old bundle.
- **Authorize** (or forbid) any future wrangler deploy / dashboard rollback test.
- **Authorize** optional D1 schema-only dump into canon docs (still no customer/RFQ row export without separate approval).
- Do **not** start Proof Pack implementation or production deploy from this gate alone.
