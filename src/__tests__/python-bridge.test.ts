import { describe, it, expect } from 'vitest';
import {
  isPythonSwarmAvailable,
  loadHiveProfiles,
  parseStdoutProtocol,
} from '../atlas/python-bridge.js';

describe('python-bridge', () => {
  it('detects VOLAURA Python swarm availability', () => {
    const available = isPythonSwarmAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('loadHiveProfiles returns array (may be empty)', async () => {
    const profiles = await loadHiveProfiles();
    expect(Array.isArray(profiles)).toBe(true);
  });

  it('loadHiveProfiles entries have model or name field if present', async () => {
    const profiles = await loadHiveProfiles();
    for (const p of profiles) {
      expect(p['model'] || p['name']).toBeTruthy();
    }
  });

  it('parseStdoutProtocol accepts valid atlas-swarm JSON line', () => {
    const stdout = 'log line\n{"bridge":"atlas-swarm","runId":"abc-123","proposals":[{"title":"test"}]}\n';
    const parsed = parseStdoutProtocol(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.runId).toBe('abc-123');
    expect(parsed!.proposals).toHaveLength(1);
  });

  it('parseStdoutProtocol rejects missing bridge field', () => {
    const stdout = '{"runId":"abc","proposals":[]}\n';
    expect(parseStdoutProtocol(stdout)).toBeNull();
  });

  it('parseStdoutProtocol rejects stale non-protocol stdout', () => {
    const stdout = 'Running swarm...\nDone.\n';
    expect(parseStdoutProtocol(stdout)).toBeNull();
  });
});
