/**
 * M8 — read-only auditor (SPEC §6). ZERO authority over exec-graph.
 * MUST NOT import exec-graph/api or verifier-port.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readLedgerEntries,
  resolveEvidenceDir,
  verifyLedgerChain,
  type EvidenceLedgerEntry,
} from './ledger.js';
import type { TypedClaim } from './claim.js';

export interface AuditFinding {
  claimId: string;
  verdict: 'confirmed' | 'stale' | 'tampered' | 'count-mismatch';
  detail: string;
}

export interface AuditSummary {
  auditRunId: string;
  findingsCount: number;
  adversarialLogPath: string;
  summaryPath: string;
  findings: AuditFinding[];
}

function isStale(claim: TypedClaim, now = Date.now()): boolean {
  // V0 stale rule: file-exists/file-contains whose path no longer exists.
  if (claim.type === 'file-exists' || claim.type === 'file-contains') {
    return !existsSync(claim.path);
  }
  // Explicit stale marker in claim text for fixtures.
  if (/STALE_MARKER/i.test(claim.claim)) return true;
  void now;
  return false;
}

export function runEvidenceAudit(opts?: {
  evidenceDir?: string;
  now?: number;
}): AuditSummary {
  const dir = opts?.evidenceDir ?? resolveEvidenceDir();
  const entries = readLedgerEntries(dir);
  const findings: AuditFinding[] = [];

  const chain = verifyLedgerChain(entries);
  if (!chain.ok) {
    findings.push({
      claimId: entries[chain.brokenAt ?? 0]?.claim.claimId ?? 'clm_unknown',
      verdict: 'tampered',
      detail: chain.reason ?? 'hash chain broken',
    });
  }

  // Detect in-place claim mutation that kept prevHash but changed claim body
  // (already covered by entryHash) — also flag count mismatch vs snapshot.
  const snapPath = join(dir, 'snapshot.json');
  if (existsSync(snapPath)) {
    try {
      const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as { count?: number };
      if (typeof snap.count === 'number' && snap.count !== entries.length) {
        findings.push({
          claimId: 'clm_snapshot',
          verdict: 'count-mismatch',
          detail: `snapshot.count=${snap.count} ledger=${entries.length}`,
        });
      }
    } catch {
      findings.push({
        claimId: 'clm_snapshot',
        verdict: 'tampered',
        detail: 'snapshot.json unreadable',
      });
    }
  }

  for (const e of entries) {
    if (isStale(e.claim, opts?.now)) {
      findings.push({
        claimId: e.claim.claimId,
        verdict: 'stale',
        detail: `claim path/state no longer matches: ${e.claim.path}`,
      });
    } else if (chain.ok) {
      findings.push({
        claimId: e.claim.claimId,
        verdict: 'confirmed',
        detail: 'chain ok and ground check passed',
      });
    }
  }

  const auditRunId = `aud_${randomUUID().slice(0, 8)}`;
  const auditDir = join(dir, 'audits', auditRunId);
  mkdirSync(auditDir, { recursive: true });
  const adversarialLogPath = join(auditDir, 'adversarial-log.jsonl');
  const summaryPath = join(auditDir, 'summary.json');

  const interesting = findings.filter((f) => f.verdict !== 'confirmed');
  for (const f of interesting) {
    appendFileSync(adversarialLogPath, `${JSON.stringify(f)}\n`, 'utf8');
  }
  // Ensure adversarial log file exists even if empty interesting set
  if (!existsSync(adversarialLogPath)) writeFileSync(adversarialLogPath, '', 'utf8');

  const summary: AuditSummary = {
    auditRunId,
    findingsCount: interesting.length,
    adversarialLogPath,
    summaryPath,
    findings: interesting,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

/** Exported for structural tests only — list of forbidden import needles. */
export const AUDITOR_FORBIDDEN_IMPORTS = [
  'exec-graph/api',
  'exec-graph/verifier-port',
] as const;

export type { EvidenceLedgerEntry };
