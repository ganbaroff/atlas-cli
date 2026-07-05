import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Full-cycle test of the in-repo queue worker against a MOCKED Supabase +
 * in-memory queue. Proves: produce → claim → execute → complete(result+receipt),
 * plus pause/over-cap guards, idempotent atomic claim, and stale re-claim.
 *
 * The mock models `atlas_command_queue` + the RPCs (claim_next_command,
 * sweep_stale_commands) by intercepting global fetch, so the REAL
 * supabase-memory.ts producer/consumer code paths run unchanged.
 */

interface Row {
  id: string;
  idempotency_key: string;
  source: string;
  chat_id: number;
  command: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  result?: unknown;
  error?: string | null;
  claimed_at?: number; // epoch ms — for stale simulation
  priority: number;
}

// In-memory queue shared across the fetch mock.
let queue: Row[] = [];
let idSeq = 0;
let staleTimeoutMs = 30 * 60 * 1000;

function installFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, opts: any = {}) => {
    const u = String(url);
    const method = (opts.method ?? 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    const ok = (data: unknown) =>
      ({ ok: true, status: 200, text: async () => JSON.stringify(data) } as Response);

    // Producer: INSERT into atlas_command_queue.
    if (u.includes('/rest/v1/atlas_command_queue') && method === 'POST') {
      const row: Row = {
        id: `cmd-${++idSeq}`,
        idempotency_key: body.idempotency_key,
        source: body.source,
        chat_id: body.chat_id,
        command: body.command,
        status: 'pending',
        priority: 0,
      };
      queue.push(row);
      return ok([row]);
    }

    // Consumer: atomic claim RPC (FOR UPDATE SKIP LOCKED emulation).
    if (u.includes('/rpc/claim_next_command')) {
      const next = queue.find((r) => r.status === 'pending');
      if (!next) return ok([]);
      next.status = 'processing';
      next.claimed_at = Date.now();
      return ok([
        { id: next.id, command: next.command, payload: null, chat_id: next.chat_id, priority: next.priority },
      ]);
    }

    // Stale sweep RPC: processing rows older than timeout → back to pending.
    if (u.includes('/rpc/sweep_stale_commands')) {
      const cutoff = Date.now() - staleTimeoutMs;
      let swept = 0;
      for (const r of queue) {
        if (r.status === 'processing' && (r.claimed_at ?? 0) < cutoff) {
          r.status = 'pending';
          r.claimed_at = undefined;
          swept++;
        }
      }
      return ok({ swept });
    }

    // completeCommand: PATCH guarded on status=eq.processing.
    if (u.includes('/rest/v1/atlas_command_queue') && method === 'PATCH') {
      const idMatch = u.match(/id=eq\.([^&]+)/);
      const id = idMatch ? idMatch[1] : '';
      const guardProcessing = u.includes('status=eq.processing');
      const row = queue.find((r) => r.id === id);
      if (row && (!guardProcessing || row.status === 'processing')) {
        if (body.status) row.status = body.status;
        if ('result' in body) row.result = body.result;
        if ('error' in body) row.error = body.error;
      }
      return ok(null);
    }

    return ok(null);
  });
}

describe('in-repo queue worker (consumer)', () => {
  beforeEach(() => {
    queue = [];
    idSeq = 0;
    staleTimeoutMs = 30 * 60 * 1000;
    vi.unstubAllEnvs();
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
    installFetchMock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('full cycle: produce → claim → execute → complete with result + receipt', async () => {
    const { queueRemoteCommand } = await import('../atlas/supabase-memory.js');
    const { runWorkerTick, _resetSkipLog } = await import('../atlas/queue-worker.js');
    _resetSkipLog();

    const id = await queueRemoteCommand(42, 'health check');
    expect(queue.find((r) => r.id === id)?.status).toBe('pending');

    const executor = vi.fn(async () => 'executor ran ok');
    const res = await runWorkerTick({ executor, paused: () => false, overCap: () => false });

    expect(res).toMatchObject({ claimed: true, executed: true, commandId: id });
    expect(executor).toHaveBeenCalledTimes(1);

    const row = queue.find((r) => r.id === id)!;
    expect(row.status).toBe('done');
    const result = row.result as { output: string; receipt: string };
    expect(result.output).toBe('executor ran ok');
    expect(result.receipt).toContain('Receipt');
    expect(result.receipt).toContain('health check');
  });

  it('ATLAS_PAUSE blocks execution and leaves the command pending', async () => {
    const { queueRemoteCommand } = await import('../atlas/supabase-memory.js');
    const { runWorkerTick, _resetSkipLog } = await import('../atlas/queue-worker.js');
    _resetSkipLog();

    const id = await queueRemoteCommand(1, 'do thing');
    const executor = vi.fn(async () => 'nope');
    const res = await runWorkerTick({ executor, paused: () => true, overCap: () => false });

    expect(res.skippedReason).toBe('paused');
    expect(executor).not.toHaveBeenCalled();
    expect(queue.find((r) => r.id === id)?.status).toBe('pending'); // unclaimed
  });

  it('over daily cap blocks execution and leaves the command pending', async () => {
    const { queueRemoteCommand } = await import('../atlas/supabase-memory.js');
    const { runWorkerTick, _resetSkipLog } = await import('../atlas/queue-worker.js');
    _resetSkipLog();

    const id = await queueRemoteCommand(1, 'spendy');
    const executor = vi.fn(async () => 'nope');
    const res = await runWorkerTick({ executor, paused: () => false, overCap: () => true });

    expect(res.skippedReason).toBe('over-cap');
    expect(executor).not.toHaveBeenCalled();
    expect(queue.find((r) => r.id === id)?.status).toBe('pending');
  });

  it('idempotent: two workers do not double-execute the same item', async () => {
    const { queueRemoteCommand } = await import('../atlas/supabase-memory.js');
    const { runWorkerTick, _resetSkipLog } = await import('../atlas/queue-worker.js');
    _resetSkipLog();

    await queueRemoteCommand(7, 'once only');

    const execA = vi.fn(async () => 'A');
    const execB = vi.fn(async () => 'B');
    const [ra, rb] = await Promise.all([
      runWorkerTick({ executor: execA, workerId: 'A', paused: () => false, overCap: () => false }),
      runWorkerTick({ executor: execB, workerId: 'B', paused: () => false, overCap: () => false }),
    ]);

    // Exactly one worker claimed+executed; the other found the queue empty.
    const executions = execA.mock.calls.length + execB.mock.calls.length;
    expect(executions).toBe(1);
    const claimedCount = [ra, rb].filter((r) => r.claimed).length;
    expect(claimedCount).toBe(1);
    expect(queue.filter((r) => r.status === 'done').length).toBe(1);
  });

  it('stale claim is re-claimable after the 30-min TTL', async () => {
    const { queueRemoteCommand } = await import('../atlas/supabase-memory.js');
    const { runWorkerTick, _resetSkipLog } = await import('../atlas/queue-worker.js');
    _resetSkipLog();

    const id = await queueRemoteCommand(9, 'crashed mid-run');

    // Simulate a worker that claimed but crashed: row stuck in processing, old claim.
    const row = queue.find((r) => r.id === id)!;
    row.status = 'processing';
    row.claimed_at = Date.now() - 31 * 60 * 1000; // 31 min ago → stale

    // A healthy tick sweeps the stale claim then re-claims and completes it.
    const executor = vi.fn(async () => 'recovered');
    const res = await runWorkerTick({ executor, paused: () => false, overCap: () => false });

    expect(res).toMatchObject({ claimed: true, executed: true, commandId: id });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(queue.find((r) => r.id === id)?.status).toBe('done');
  });

  it('never throws when Supabase claim fails — returns non-claimed', async () => {
    const { runWorkerTick, _resetSkipLog } = await import('../atlas/queue-worker.js');
    _resetSkipLog();

    // Make the claim RPC blow up.
    (globalThis.fetch as any).mockImplementationOnce(async (url: any) => {
      const u = String(url);
      // sweep succeeds, claim throws
      if (u.includes('/rpc/sweep_stale_commands')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ swept: 0 }) } as Response;
      }
      throw new Error('network down');
    });

    const executor = vi.fn(async () => 'x');
    await expect(
      runWorkerTick({ executor, paused: () => false, overCap: () => false }),
    ).resolves.toMatchObject({ claimed: false, executed: false });
  });

  it('inProcWorkerEnabled reads ATLAS_INPROC_WORKER lazily; startInProcWorker is OFF by default', async () => {
    const { inProcWorkerEnabled, startInProcWorker } = await import('../atlas/queue-worker.js');

    vi.stubEnv('ATLAS_INPROC_WORKER', '');
    expect(inProcWorkerEnabled()).toBe(false);
    const off = startInProcWorker(1000);
    expect(off.enabled).toBe(false);
    off.stop();

    vi.stubEnv('ATLAS_INPROC_WORKER', '1');
    expect(inProcWorkerEnabled()).toBe(true);
    const on = startInProcWorker(1_000_000);
    expect(on.enabled).toBe(true);
    on.stop();
  });
});
