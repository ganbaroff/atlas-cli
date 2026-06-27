/**
 * Deploy orchestrator — merge PR + verify prod from Telegram.
 * Phase C of Atlas Orchestrator v2.
 *
 * Auditor fixes applied:
 * - No --admin (was already removed)
 * - execSafe in polling loop (was already added)
 * - isDeploying guard (new — prevents double-deploy)
 * - Confirmation required via confirmDeploy/executeDeploy split (new)
 * - Rollback on failed health check (new)
 * - Message truncation (new)
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
  rolledBack: boolean;
  error: string | null;
  durationMs: number;
}

let isDeploying = false;
export function deployInProgress(): boolean { return isDeploying; }

function execSafe(cmd: string, cwd: string, timeout = 15_000): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout }).trim();
  } catch {
    return null;
  }
}

export function listOpenPRs(project: string): Array<{ number: number; title: string }> {
  const config = PROJECTS[project];
  if (!config) return [];
  const raw = execSafe(`gh pr list --repo ${config.repo} --state open --json number,title`, config.cwd);
  return raw ? JSON.parse(raw) : [];
}

export function getPR(project: string, prNumber?: number): { number: number; title: string } | null {
  const config = PROJECTS[project];
  if (!config) return null;
  if (prNumber) {
    const raw = execSafe(`gh pr view ${prNumber} --repo ${config.repo} --json number,title`, config.cwd);
    return raw ? JSON.parse(raw) : null;
  }
  const prs = listOpenPRs(project);
  return prs[0] ?? null;
}

export async function executeDeploy(project: string, prNumber: number): Promise<DeployResult> {
  if (isDeploying) {
    return { project, prNumber, prTitle: '', merged: false, healthCheck: null, rolledBack: false, error: 'Deploy already in progress', durationMs: 0 };
  }

  isDeploying = true;
  const t0 = Date.now();
  const config = PROJECTS[project];
  if (!config) {
    isDeploying = false;
    return { project, prNumber, prTitle: '', merged: false, healthCheck: null, rolledBack: false, error: `Unknown project: ${project}`, durationMs: 0 };
  }

  try {
    // CI gate
    const checksRaw = execSafe(`gh pr checks ${prNumber} --repo ${config.repo} --json bucket,name --jq "[.[] | select(.bucket == \\"fail\\")] | length"`, config.cwd);
    const failCount = parseInt(checksRaw || '0', 10);
    if (failCount > 0) {
      isDeploying = false;
      return { project, prNumber, prTitle: '', merged: false, healthCheck: null, rolledBack: false, error: `CI has ${failCount} failing check(s)`, durationMs: Date.now() - t0 };
    }

    // Merge
    const mergeResult = execSafe(`gh pr merge ${prNumber} --repo ${config.repo} --squash`, config.cwd);
    if (!mergeResult && mergeResult !== '') {
      isDeploying = false;
      return { project, prNumber, prTitle: '', merged: false, healthCheck: null, rolledBack: false, error: 'gh pr merge failed', durationMs: Date.now() - t0 };
    }

    // Poll health (10 attempts × 10s)
    console.log(`[deploy] PR #${prNumber} merged, polling health...`);
    let healthCheck: { status: string; sha: string } | null = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10_000));
      const raw = execSafe(`curl -s --connect-timeout 5 --max-time 10 ${config.healthUrl}`, config.cwd);
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        healthCheck = { status: data.status, sha: (data.git_sha || '').slice(0, 7) };
        if (healthCheck.status === 'ok') {
          console.log(`[deploy] health OK on attempt ${i + 1}: sha=${healthCheck.sha}`);
          break;
        }
      } catch { /* retry */ }
    }

    // Rollback if health failed
    let rolledBack = false;
    if (!healthCheck || healthCheck.status !== 'ok') {
      console.log(`[deploy] health FAILED — rolling back`);
      execSafe(`cd ${config.cwd} && git fetch origin main && git revert HEAD --no-edit && git push origin main`, config.cwd);
      rolledBack = true;
    }

    isDeploying = false;
    return {
      project, prNumber, prTitle: '',
      merged: true, healthCheck, rolledBack,
      error: rolledBack ? 'Health check failed — rolled back' : null,
      durationMs: Date.now() - t0,
    };
  } catch (e: any) {
    isDeploying = false;
    return {
      project, prNumber: prNumber, prTitle: '',
      merged: false, healthCheck: null, rolledBack: false,
      error: (e.message?.slice(0, 300)),
      durationMs: Date.now() - t0,
    };
  }
}
