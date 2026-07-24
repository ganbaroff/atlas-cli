/**
 * M8 evidence tests — chain integrity, auditor findings, structural ban.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appendClaim, readLedgerEntries, verifyLedgerChain } from '../evidence/ledger.js';
import { runEvidenceAudit, AUDITOR_FORBIDDEN_IMPORTS } from '../evidence/auditor.js';

const AUDITOR_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../evidence/auditor.ts');

describe('M8 evidence ledger + auditor', () => {
  let dir: string;
  let fixtureFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-evidence-'));
    process.env.ATLAS_EVIDENCE_DIR = dir;
    delete process.env.ATLAS_READONLY;
    fixtureFile = join(dir, 'ok.txt');
    writeFileSync(fixtureFile, 'hello evidence', 'utf8');
  });

  afterEach(() => {
    delete process.env.ATLAS_EVIDENCE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  function baseClaim(partial: Record<string, unknown>) {
    return {
      claimId: 'clm_a1',
      claim: 'file exists',
      type: 'file-exists',
      path: fixtureFile,
      confidence: 0.7,
      source: 'atlas',
      ts: new Date().toISOString(),
      ...partial,
    };
  }

  it('append builds a valid hash chain; mutating a line breaks verification', () => {
    appendClaim(baseClaim({ claimId: 'clm_01' }));
    appendClaim(baseClaim({ claimId: 'clm_02', claim: 'second' }));
    appendClaim(baseClaim({ claimId: 'clm_03', type: 'narrative', confidence: 0, path: 'n/a' }));
    const entries = readLedgerEntries(dir);
    expect(verifyLedgerChain(entries).ok).toBe(true);

    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    const mid = JSON.parse(lines[1]!);
    mid.claim.claim = 'TAMPERED';
    lines[1] = JSON.stringify(mid);
    writeFileSync(join(dir, 'ledger.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    expect(verifyLedgerChain(readLedgerEntries(dir)).ok).toBe(false);
  });

  it('fixture audit finds stale + tampered (findingsCount >= 2) and writes adversarial log', () => {
    appendClaim(baseClaim({ claimId: 'clm_ok1' }));
    appendClaim(baseClaim({ claimId: 'clm_ok2', claim: 'ok2' }));
    appendClaim(baseClaim({
      claimId: 'clm_ok3',
      type: 'file-contains',
      expectedSubstring: 'hello',
      claim: 'contains hello',
    }));
    const gone = join(dir, 'gone.txt');
    writeFileSync(gone, 'bye', 'utf8');
    appendClaim(baseClaim({ claimId: 'clm_stale', path: gone, claim: 'STALE_MARKER will delete' }));
    rmSync(gone, { force: true });
    appendClaim(baseClaim({ claimId: 'clm_tbase', claim: 'before tamper' }));
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]!);
    last.claim.claim = 'silently rewritten';
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(join(dir, 'ledger.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    const summary = runEvidenceAudit({ evidenceDir: dir });
    expect(summary.findingsCount).toBeGreaterThanOrEqual(2);
    expect(existsSync(summary.adversarialLogPath)).toBe(true);
    const verdicts = new Set(summary.findings.map((f) => f.verdict));
    expect(verdicts.has('stale')).toBe(true);
    expect(verdicts.has('tampered')).toBe(true);
  });

  it('auditor module does not import exec-graph mutating APIs', () => {
    const src = readFileSync(AUDITOR_SRC, 'utf8');
    expect(src).not.toMatch(/from ['"].*exec-graph\/api['"]/);
    expect(src).not.toMatch(/from ['"].*exec-graph\/verifier-port['"]/);
    expect(src).not.toMatch(/import\(['"].*exec-graph\/api/);
    expect(AUDITOR_FORBIDDEN_IMPORTS.length).toBe(2);
  });
});
