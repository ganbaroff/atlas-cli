/**
 * M8 — hash-chained append-only evidence ledger (SPEC §4).
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseTypedClaim, type TypedClaim } from './claim.js';
import { assertWritable } from '../atlas/readonly-guard.js';
import { resolveMigratingStateDir } from '../atlas/state-root.js';

export interface EvidenceLedgerEntry {
  prevHash: string | null;
  entryHash: string;
  claim: TypedClaim;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

export function resolveEvidenceDir(): string {
  const dir = resolveMigratingStateDir(
    'evidence',
    () => join(process.cwd(), 'state', 'evidence'),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ledgerPath(dir = resolveEvidenceDir()): string {
  return join(dir, 'ledger.jsonl');
}

export function readLedgerEntries(dir = resolveEvidenceDir()): EvidenceLedgerEntry[] {
  const path = ledgerPath(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvidenceLedgerEntry);
}

export function verifyLedgerChain(entries: EvidenceLedgerEntry[]): {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
} {
  let prev: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.prevHash !== prev) {
      return { ok: false, brokenAt: i, reason: `prevHash mismatch at ${i}` };
    }
    const expected = hashPayload({ prevHash: e.prevHash, claim: e.claim });
    if (e.entryHash !== expected) {
      return { ok: false, brokenAt: i, reason: `entryHash mismatch at ${i}` };
    }
    prev = e.entryHash;
  }
  return { ok: true };
}

export function appendClaim(claimInput: unknown, dir = resolveEvidenceDir()): EvidenceLedgerEntry {
  assertWritable('evidence.appendClaim');
  const claim = parseTypedClaim(claimInput);
  const entries = readLedgerEntries(dir);
  const existing = entries.find((e) => e.claim.claimId === claim.claimId);
  if (existing) return existing;
  const chain = verifyLedgerChain(entries);
  if (!chain.ok) {
    throw new Error(`evidence: refuse append — chain broken: ${chain.reason}`);
  }
  const prevHash = entries.length ? entries[entries.length - 1]!.entryHash : null;
  const entryHash = hashPayload({ prevHash, claim });
  const entry: EvidenceLedgerEntry = { prevHash, entryHash, claim };
  appendFileSync(ledgerPath(dir), `${JSON.stringify(entry)}\n`, 'utf8');
  const snapshot = {
    claims: [...entries.map((e) => e.claim), claim],
    lastEntryHash: entryHash,
    count: entries.length + 1,
  };
  const snapPath = join(dir, 'snapshot.json');
  const tmp = `${snapPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  renameSync(tmp, snapPath);
  return entry;
}
