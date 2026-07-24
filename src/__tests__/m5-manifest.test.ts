/**
 * M5 — manifest SDK + file-search hand registration without REGISTRY edits.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getHand, listHands, HandNotFoundError } from '../hands/registry.js';
import {
  assertManifestCapabilitiesConsistent,
  loadHandManifests,
  ManifestValidationError,
  resetManifestCacheForTests,
} from '../hands/manifest.js';
import { runFileSearch } from '../hands/file-search.js';

const REGISTRY_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../hands/registry.ts');

describe('M5 manifest SDK', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-manifest-'));
    process.env.ATLAS_HAND_MANIFEST_DIR = dir;
    resetManifestCacheForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_HAND_MANIFEST_DIR;
    resetManifestCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads valid manifest and rejects malformed', () => {
    writeFileSync(
      join(dir, 'ok.json'),
      JSON.stringify({
        handId: 'tmp-ok',
        purpose: 'temp',
        capabilities: ['read-file'],
        trustLevel: 'low',
        allowedEnvironments: ['local-foreground'],
        allowedActions: ['read-file'],
        disallowedActions: ['write'],
        costClass: 'FREE',
        autonomy: 'read-only-unattended',
        inputContract: 'brief',
        timeoutMs: 1000,
        retryPolicy: 'none',
        abortPolicy: 'block',
        escalationCondition: 'escalate',
      }),
    );
    const map = loadHandManifests(dir);
    expect(map.get('tmp-ok')?.handId).toBe('tmp-ok');

    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ handId: 'x' }));
    expect(() => loadHandManifests(dir)).toThrow(ManifestValidationError);
  });

  it('rejects capability escalation (allowedAction outside capabilities)', () => {
    expect(() =>
      assertManifestCapabilitiesConsistent({
        handId: 'evil',
        purpose: 'x',
        capabilities: ['read-file'],
        trustLevel: 'low',
        allowedEnvironments: ['local-foreground'],
        allowedActions: ['read-file', 'deploy'],
        disallowedActions: [],
        costClass: 'FREE',
        autonomy: 'read-only-unattended',
        inputContract: 'x',
        timeoutMs: 1,
        retryPolicy: 'none',
        abortPolicy: 'x',
        escalationCondition: 'x',
      }),
    ).toThrow(/deploy/);
  });

  it('local-readonly hand is available via manifest without REGISTRY literal', () => {
    delete process.env.ATLAS_HAND_MANIFEST_DIR;
    resetManifestCacheForTests();
    const hand = getHand('local-readonly');
    expect(hand.handId).toBe('local-readonly');
    expect(hand.autonomy).toBe('read-only-unattended');
    expect(listHands().some((h) => h.handId === 'local-readonly')).toBe(true);

    const registrySrc = readFileSync(REGISTRY_SRC, 'utf8');
    expect(registrySrc).not.toMatch(/'local-readonly'\s*:/);
    expect(registrySrc).not.toMatch(/handId:\s*'local-readonly'/);
  });

  it('browser-foreground hand is available via manifest without REGISTRY literal', () => {
    delete process.env.ATLAS_HAND_MANIFEST_DIR;
    resetManifestCacheForTests();
    const hand = getHand('browser-foreground');
    expect(hand.handId).toBe('browser-foreground');
    expect(hand.allowedActions).toContain('browser-navigate');
    expect(hand.disallowedActions).toContain('browser-submit');
    expect(listHands().some((h) => h.handId === 'browser-foreground')).toBe(true);

    const registrySrc = readFileSync(REGISTRY_SRC, 'utf8');
    expect(registrySrc).not.toMatch(/'browser-foreground'\s*:/);
    expect(registrySrc).not.toMatch(/handId:\s*'browser-foreground'/);
  });

  it('swarm-local hand is available via manifest without REGISTRY literal', () => {
    delete process.env.ATLAS_HAND_MANIFEST_DIR;
    resetManifestCacheForTests();
    const hand = getHand('swarm-local');
    expect(hand.handId).toBe('swarm-local');
    expect(hand.allowedActions).toContain('swarm-run');
    expect(listHands().some((h) => h.handId === 'swarm-local')).toBe(true);

    const registrySrc = readFileSync(REGISTRY_SRC, 'utf8');
    expect(registrySrc).not.toMatch(/'swarm-local'\s*:/);
    expect(registrySrc).not.toMatch(/handId:\s*'swarm-local'/);
  });

  it('sonnet-foreground hand is available via manifest without REGISTRY literal', () => {
    delete process.env.ATLAS_HAND_MANIFEST_DIR;
    resetManifestCacheForTests();
    const hand = getHand('sonnet-foreground');
    expect(hand.handId).toBe('sonnet-foreground');
    expect(hand.allowedActions).toContain('write-scoped-code');
    expect(listHands().some((h) => h.handId === 'sonnet-foreground')).toBe(true);

    const registrySrc = readFileSync(REGISTRY_SRC, 'utf8');
    expect(registrySrc).not.toMatch(/'sonnet-foreground'\s*:/);
    expect(registrySrc).not.toMatch(/handId:\s*'sonnet-foreground'/);
    expect(registrySrc).toMatch(/REGISTRY.*Object\.freeze\(\{\}\)/);
  });

  it('file-search hand is available via default manifests without REGISTRY literal', () => {
    delete process.env.ATLAS_HAND_MANIFEST_DIR;
    resetManifestCacheForTests();
    const hand = getHand('file-search');
    expect(hand.handId).toBe('file-search');
    expect(hand.allowedActions).toContain('file-search');
    expect(listHands().some((h) => h.handId === 'file-search')).toBe(true);

    const registrySrc = readFileSync(REGISTRY_SRC, 'utf8');
    // DoD: second hand registered via manifest — REGISTRY object must not contain file-search literal.
    expect(registrySrc).not.toMatch(/'file-search'\s*:/);
    expect(registrySrc).not.toMatch(/handId:\s*'file-search'/);
  });

  it('runFileSearch finds files by name pattern', () => {
    writeFileSync(join(dir, 'hello-world.txt'), 'alpha beta gamma');
    const result = runFileSearch({ root: dir, pattern: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.hits.some((h) => h.path.includes('hello-world'))).toBe(true);
  });

  it('unknown hand still throws HandNotFoundError', () => {
    expect(() => getHand('does-not-exist')).toThrow(HandNotFoundError);
  });
});
