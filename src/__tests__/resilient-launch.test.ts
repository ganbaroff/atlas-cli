import { describe, it, expect, vi } from 'vitest';
import { launchWithRetry } from '../atlas/resilient-launch.js';

const instantSleep = (): Promise<void> => Promise.resolve();

describe('launchWithRetry', () => {
  it('resolves after launch rejects twice then resolves, onRetry called 2x, no throw', async () => {
    let calls = 0;
    const launch = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error(`conflict ${calls}`);
    });
    const onRetry = vi.fn();

    await expect(
      launchWithRetry(launch, { onRetry, sleep: instantSleep }),
    ).resolves.toBeUndefined();

    expect(launch).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
  });

  it('rejects after exhausting maxTries, onRetry called maxTries-1 times, never calls process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit should never be called by launchWithRetry');
    }) as never);
    const launch = vi.fn(async () => {
      throw new Error('always fails');
    });
    const onRetry = vi.fn();

    await expect(
      launchWithRetry(launch, { maxTries: 3, onRetry, sleep: instantSleep }),
    ).rejects.toThrow('always fails');

    expect(launch).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('resolves on first try without calling onRetry', async () => {
    const launch = vi.fn(async () => {});
    const onRetry = vi.fn();

    await expect(
      launchWithRetry(launch, { onRetry, sleep: instantSleep }),
    ).resolves.toBeUndefined();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
