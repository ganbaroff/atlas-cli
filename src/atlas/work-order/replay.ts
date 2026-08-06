/**
 * atlas/work-order/replay.ts — durable one-time-use protection for signed
 * Work Orders.
 *
 * Mirrors atlas/queue-auth.ts's file-backed nonce ledger (bounded growth,
 * eviction, atomic rename-based writes) so replay refusal survives a
 * process restart: the check always re-reads from disk on fresh
 * instantiation, never trusts in-memory state alone.
 *
 * Per the P1-A wave-1 hard rule ("do NOT create a new database or a new
 * state family without registering it in state-writer-inventory.ts"): this
 * reuses the EXISTING 'queue-auth' state-root store (see
 * atlas/state-root.ts's STATE_STORES and atlas/queue-auth.ts's own
 * resolveQueueAuthDir/createQueueAuthNonceLedger) rather than adding a new
 * store to state-root.ts's registry. The Work Order replay ledger lives in
 * the SAME directory as queue-auth's own nonce-ledger.json, distinguished
 * only by filename (work-order-replay.json) — no edit to state-root.ts is
 * needed. The new writer surface introduced here (this file) is registered
 * in state-writer-inventory.ts against that same 'queue-auth' store.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  constrainMigratingStatePath,
  resolveMigratingStateDir,
} from '../state-root.js';

export type WorkOrderReplayReason = 'nonce_replayed' | 'work_order_id_replayed';

export type WorkOrderReplayResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WorkOrderReplayReason };

export interface WorkOrderReplayStore {
  /**
   * Claim (workOrderId, nonce) as consumed. Returns ok:true only the first
   * time EITHER value is seen; every later call repeating either value —
   * even by the legitimate original executor after a restart — is refused.
   * This is a one-time claim gate: call it once, when a Work Order is
   * accepted for execution, not once per file touched or per retry.
   */
  consumeIfFresh(workOrderId: string, nonce: string): WorkOrderReplayResult;
}

const REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REPLAY_ENTRY_CAP = 20_000; // bounded growth (two entries recorded per claim; mirrors queue-auth.ts's 10_000 cap)

interface ReplayEntry {
  kind: 'nonce' | 'work-order-id';
  value: string;
  ts: string;
}

function loadEntries(storePath: string): ReplayEntry[] {
  if (!existsSync(storePath)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!Array.isArray(raw)) return [];
    const cutoff = Date.now() - REPLAY_RETENTION_MS;
    return (raw as ReplayEntry[]).filter((entry) => Date.parse(entry.ts) > cutoff);
  } catch {
    // Corrupt file — start fresh. Worst case a replayed value gets through
    // once; the HMAC signature still guards authenticity independently.
    return [];
  }
}

function createReplayStoreAtPath(stateDir: string, storePath: string): WorkOrderReplayStore {
  mkdirSync(stateDir, { recursive: true });
  let entries = loadEntries(storePath);
  const nonceSeen = new Set(entries.filter((e) => e.kind === 'nonce').map((e) => e.value));
  const idSeen = new Set(entries.filter((e) => e.kind === 'work-order-id').map((e) => e.value));

  function persist(): void {
    const tmp = `${storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), 'utf8');
    renameSync(tmp, storePath);
  }

  // Reflect any eviction from load immediately, same as queue-auth.ts.
  if (existsSync(storePath)) persist();

  return {
    consumeIfFresh(workOrderId, nonce) {
      if (nonceSeen.has(nonce)) return { ok: false, reason: 'nonce_replayed' };
      if (idSeen.has(workOrderId)) return { ok: false, reason: 'work_order_id_replayed' };

      const now = new Date().toISOString();
      nonceSeen.add(nonce);
      idSeen.add(workOrderId);
      entries.push({ kind: 'nonce', value: nonce, ts: now });
      entries.push({ kind: 'work-order-id', value: workOrderId, ts: now });

      if (entries.length > REPLAY_ENTRY_CAP) {
        const cutoff = Date.now() - REPLAY_RETENTION_MS;
        entries = entries.filter((entry) => Date.parse(entry.ts) > cutoff);
        nonceSeen.clear();
        idSeen.clear();
        for (const entry of entries) {
          (entry.kind === 'nonce' ? nonceSeen : idSeen).add(entry.value);
        }
      }

      persist();
      return { ok: true };
    },
  };
}

/** Explicit-directory constructor — used directly by tests and by the production resolver below. */
export function createWorkOrderReplayStore(stateDir: string): WorkOrderReplayStore {
  return createReplayStoreAtPath(stateDir, join(stateDir, 'work-order-replay.json'));
}

/** Same state family as atlas/queue-auth.ts's resolveQueueAuthDir — no new store registered. */
export function resolveWorkOrderReplayDir(): string {
  return resolveMigratingStateDir('queue-auth', () => join(homedir(), '.atlas'));
}

export function createProductionWorkOrderReplayStore(): WorkOrderReplayStore {
  const stateDir = resolveWorkOrderReplayDir();
  const storePath = constrainMigratingStatePath('queue-auth', join(stateDir, 'work-order-replay.json'));
  return createReplayStoreAtPath(stateDir, storePath);
}
