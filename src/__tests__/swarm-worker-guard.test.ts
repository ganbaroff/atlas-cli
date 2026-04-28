import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('swarm-worker guard', () => {
  it('exits with non-zero when run without ATLAS_SUBTASK', () => {
    try {
      execFileSync('npx', ['tsx', resolve(__dirname, '../swarm-worker.ts')], {
        timeout: 5000,
        env: { ...process.env, ATLAS_SUBTASK: '' },
      });
      expect.unreachable('should have exited with error');
    } catch (err: unknown) {
      const e = err as { status: number | null };
      expect(e.status === 1 || e.status === null).toBe(true);
    }
  });

  it('exits with non-zero when ATLAS_SUBTASK set but no IPC channel', () => {
    try {
      execFileSync('npx', ['tsx', resolve(__dirname, '../swarm-worker.ts')], {
        timeout: 5000,
        env: {
          ...process.env,
          ATLAS_SUBTASK: JSON.stringify({ id: 0, description: 'test', perspective: 'qa' }),
        },
      });
      expect.unreachable('should have exited with error');
    } catch (err: unknown) {
      const e = err as { status: number | null };
      expect(e.status === 1 || e.status === null).toBe(true);
    }
  });
});
