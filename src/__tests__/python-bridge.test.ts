import { describe, it, expect } from 'vitest';
import { isPythonSwarmAvailable, loadHiveProfiles } from '../atlas/python-bridge.js';

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
});
