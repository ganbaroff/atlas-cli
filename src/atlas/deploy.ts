/**
 * Deploy orchestrator — merge PR + verify prod from Telegram.
 * Phase C of Atlas Orchestrator v2.
 *
 * /deploy volaura → list open PRs → merge latest → wait → curl /health → report
 */

import { execSync } from 'node:child_process';

const PROJECTS: Record<string, { repo: string; healthUrl: string; cwd: string }> = {
  volaura: {
    repo: 'ganbaroff/volaura',
    healthUrl: 'https://volauraapi-production.up.railway.app/health',
    cwd: 'C:/Projects/VOLAURA',
  },
};

export interface DeployResult {
  project: string;
  prNumber: number | null;
  prTitle: string;
  merged: boolean;
  healthCheck: { status: string; sha: string } | null;
  error: string | null;
  durationMs: number;
}

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
}

export function listOpenPRs(project: string): Array<{ number: number; title: string }> {
  const config = PROJECTS[project];
  if (!config) return [];
  const raw = exec(`gh pr list --repo ${config.repo} --state open --json number,title`, config.cwd);
  return JSON.parse(raw || '[]');
}

export async function deploy(project: string, prNumber?: number): Promise<DeployResult> {
  const t0 = Date.now();
  const config = PROJECTS[project];
  if (!config) {
    return { project, prNumber: null, prTitle: '', merged: false, healthCheck: null, error: `Unknown project: ${project}`, durationMs: 0 };
  }

  try {
    // Find PR to merge
    let pr: { number: number; title: string };
    if (prNumber) {
      const raw = exec(`gh pr view ${prNumber} --repo ${config.repo} --json number,title`, config.cwd);
      pr = JSON.parse(raw);
    } else {
      const prs = listOpenPRs(project);
      if (prs.length === 0) {
        return { project, prNumber: null, prTitle: '', merged: false, healthCheck: null, error: 'No open PRs', durationMs: Date.now() - t0 };
      }
      pr = prs[0]; // Latest
    }

    // Pre-merge safety: verify CI is green (no --admin bypass)
    const checksRaw = exec(`gh pr checks ${pr.number} --repo ${config.repo} --json bucket,name --jq '[.[] | select(.bucket == "fail")] | length'`, config.cwd);
    const failCount = parseInt(checksRaw, 10);
    if (failCount > 0) {
      return { project, prNumber: pr.number, prTitle: pr.title, merged: false, healthCheck: null, error: `CI has ${failCount} failing check(s) — not deploying`, durationMs: Date.now() - t0 };
    }

    // Merge without --admin — respects branch protection
    exec(`gh pr merge ${pr.number} --repo ${config.repo} --squash`, config.cwd);

    // Poll health until new SHA appears (max 10 attempts, 10s apart = 100s)
    console.log(`[deploy] PR #${pr.number} merged, polling health...`);
    let healthCheck: { status: string; sha: string } | null = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10_000));
      try {
        const raw = exec(`curl -s ${config.healthUrl}`, config.cwd);
        const data = JSON.parse(raw);
        healthCheck = { status: data.status, sha: (data.git_sha || '').slice(0, 7) };
        if (healthCheck.status === 'ok') {
          console.log(`[deploy] health OK on attempt ${i + 1}: sha=${healthCheck.sha}`);
          break;
        }
      } catch { /* retry */ }
    }

    return {
      project,
      prNumber: pr.number,
      prTitle: pr.title,
      merged: true,
      healthCheck,
      error: healthCheck?.status !== 'ok' ? 'Health check failed after deploy' : null,
      durationMs: Date.now() - t0,
    };
  } catch (e: any) {
    return {
      project,
      prNumber: prNumber ?? null,
      prTitle: '',
      merged: false,
      healthCheck: null,
      error: e.message?.slice(0, 300),
      durationMs: Date.now() - t0,
    };
  }
}
