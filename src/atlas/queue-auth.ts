/**
 * atlas/queue-auth.ts — work-order authenticity (P0.1 Wave D).
 *
 * Signs outgoing queue rows with HMAC-SHA256 so the runner can verify
 * who enqueued them. Uses node:crypto only — no new dependencies.
 *
 * Signing key: env var ATLAS_QUEUE_SIGNING_KEY (name only — value is
 * operator-set, never in code/tests/logs/reports).
 *
 * Canonical serialization: JSON.stringify({command, chat_id, ts, nonce})
 * with keys in that exact order.
 */

import { createHmac, randomUUID } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────

export interface SignedFields {
  sig: string;
  ts: string;
  nonce: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'unsigned' | 'sig-mismatch' | 'expired' | 'nonce-reuse' };

export interface NonceLedger {
  /** Check if a nonce has been seen. If not, record it. Returns true if fresh. */
  recordIfFresh(nonce: string): boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Signing (producer side) ────────────────────────────────────────────

function computeHmac(
  command: string,
  chatId: number,
  ts: string,
  nonce: string,
  key: string,
): string {
  const canonical = JSON.stringify({ command, chat_id: chatId, ts, nonce });
  return createHmac('sha256', key).update(canonical).digest('hex');
}

/**
 * Sign a queue row. Returns the fields to merge into payload, or null
 * when the key is unset (unsigned mode).
 */
export function signPayload(
  row: { command: string; chat_id: number },
  key: string | undefined,
): SignedFields | null {
  if (!key) return null;

  const ts = new Date().toISOString();
  const nonce = randomUUID();
  const sig = computeHmac(row.command, row.chat_id, ts, nonce, key);

  return { sig, ts, nonce };
}

// ── Verification (runner side) ─────────────────────────────────────────

/**
 * Verify a claimed row's authenticity. Returns ok:true or a machine-readable
 * reason string for the specific refusal class.
 */
export function verifyPayload(
  row: { command: string; chat_id: number; payload: unknown },
  key: string,
  ledger: NonceLedger,
): VerifyResult {
  // Extract signed fields from payload
  const p = row.payload as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== 'object' || !('sig' in p) || !('ts' in p) || !('nonce' in p)) {
    return { ok: false, reason: 'unsigned' };
  }

  const sig = String(p.sig);
  const ts = String(p.ts);
  const nonce = String(p.nonce);

  // Check signature
  const expected = computeHmac(row.command, row.chat_id, ts, nonce, key);
  if (sig !== expected) {
    return { ok: false, reason: 'sig-mismatch' };
  }

  // Check expiry (24h window)
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs) || Date.now() - tsMs > MAX_AGE_MS) {
    return { ok: false, reason: 'expired' };
  }

  // Check nonce reuse
  if (!ledger.recordIfFresh(nonce)) {
    return { ok: false, reason: 'nonce-reuse' };
  }

  return { ok: true };
}

// ── Nonce ledger (file-backed, bounded) ────────────────────────────────

interface LedgerEntry {
  nonce: string;
  ts: string;
}

/**
 * Create a file-backed nonce ledger. On creation, loads existing entries
 * and evicts those older than 24h (bounded growth). Persists on every
 * write so it survives runner restarts.
 */
export function createNonceLedger(stateDir: string): NonceLedger {
  const ledgerPath = join(stateDir, 'nonce-ledger.json');
  mkdirSync(stateDir, { recursive: true });

  // Load + evict stale entries
  let entries: LedgerEntry[] = [];
  if (existsSync(ledgerPath)) {
    try {
      const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      if (Array.isArray(raw)) {
        const cutoff = Date.now() - MAX_AGE_MS;
        entries = raw.filter(
          (e: LedgerEntry) => Date.parse(e.ts) > cutoff,
        );
      }
    } catch {
      // Corrupt file — start fresh (safe: worst case a replayed nonce
      // gets through once, but the HMAC still guards authenticity).
      entries = [];
    }
  }

  const nonceSet = new Set(entries.map((e) => e.nonce));

  function persist(): void {
    writeFileSync(ledgerPath, JSON.stringify(entries), 'utf8');
  }

  // Persist the evicted state immediately (so the file reflects the cleanup)
  if (existsSync(ledgerPath)) {
    persist();
  }

  return {
    recordIfFresh(nonce: string): boolean {
      if (nonceSet.has(nonce)) return false;
      nonceSet.add(nonce);
      entries.push({ nonce, ts: new Date().toISOString() });

      // Periodic eviction: if entries exceed a reasonable cap, prune old ones
      if (entries.length > 10_000) {
        const cutoff = Date.now() - MAX_AGE_MS;
        entries = entries.filter((e) => Date.parse(e.ts) > cutoff);
        // Rebuild the set
        nonceSet.clear();
        for (const e of entries) nonceSet.add(e.nonce);
      }

      persist();
      return true;
    },
  };
}

// ── Key accessor (injectable for runner deps) ──────────────────────────

/** Default accessor — reads from env. Injectable for testing. */
export function getSigningKey(): string | undefined {
  return process.env['ATLAS_QUEUE_SIGNING_KEY'] || undefined;
}
