/**
 * M3D Task 5 — retain + rehearse against a synthetic checkout fixture.
 * Never touches live ANUS state/ or ~/.atlas in these unit tests.
 */

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTHORITATIVE_FULL_ROOT_STORES,
  FullRootRehearsalError,
  seedFixtureFullRoot,
} from '../atlas/full-root-rehearsal.js';
import {
  assembleLiveFullRoot,
  planLiveAuthoritativeStores,
  preflightFullRootRetain,
  PROTECTED_DIRTY_PATHS,
  retainAndRehearseFullRoot,
} from '../atlas/full-root-retain.js';

const tempRoots: string[] = [];

function tempDir(prefix = 'atlas-full-root-retain-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) copyFileSync(src, dst);
  }
}

function writeCheckoutFixture(checkout: string): void {
  const seeded = join(checkout, '.seeded-full');
  mkdirSync(seeded);
  seedFixtureFullRoot(seeded);
  for (const store of ['exec-graph', 'evidence', 'swarm-runs', 'intake-drafts'] as const) {
    copyTree(join(seeded, store), join(checkout, 'state', store));
  }
  mkdirSync(join(checkout, 'operator', 'runs'), { recursive: true });
  writeFileSync(join(checkout, 'operator', 'runs', 'run-1.json'), '{"ok":true}\n');
  mkdirSync(join(checkout, 'state', 'goal-budgets'), { recursive: true });
  mkdirSync(join(checkout, 'operator', 'state'), { recursive: true });
  mkdirSync(join(checkout, 'state', 'learning', 'projection-locks'), { recursive: true });
  mkdirSync(join(checkout, 'docs', 'atlas-cto'), { recursive: true });
  writeFileSync(join(checkout, 'docs', 'atlas-cto', 'FABLE-PROTOCOL.md'), 'x\n');
}

describe('planLiveAuthoritativeStores', () => {
  it('covers every authoritative store against an explicit checkout', () => {
    const checkout = tempDir('atlas-retain-checkout-');
    writeCheckoutFixture(checkout);
    const plans = planLiveAuthoritativeStores(checkout);
    expect(plans.map((p) => p.store).sort()).toEqual(
      [...AUTHORITATIVE_FULL_ROOT_STORES].sort(),
    );
    expect(plans.find((p) => p.store === 'exec-graph')?.status).toBe('present');
    expect(plans.find((p) => p.store === 'goal-budgets')?.status).toBe('empty');
    expect(plans.find((p) => p.store === 'cost-router')?.kind).toBe('empty-policy');
  });
});

describe('preflightFullRootRetain', () => {
  it('accepts an absent artifact and records protected-path statuses', () => {
    const checkout = tempDir('atlas-retain-preflight-');
    writeCheckoutFixture(checkout);
    const preservation = tempDir('atlas-retain-parent-');
    const preflight = preflightFullRootRetain({
      primaryCheckoutRoot: checkout,
      preservationParentDirectory: preservation,
      artifactName: 'atlas-full-root-m3d-20260801T120000Z-abcd1234',
      porcelainPaths: ['docs/atlas-cto/FABLE-PROTOCOL.md'],
    });
    expect(preflight.accepted).toBe(true);
    expect(preflight.artifactAbsent).toBe(true);
    expect(preflight.protectedPaths).toHaveLength(PROTECTED_DIRTY_PATHS.length);
    expect(
      preflight.protectedPaths.find((p) => p.path.includes('FABLE-PROTOCOL'))?.status,
    ).toBe('dirty');
  });

  it('refuses when the artifact directory already exists', () => {
    const checkout = tempDir();
    writeCheckoutFixture(checkout);
    const preservation = tempDir();
    const name = 'atlas-full-root-m3d-20260801T120001Z-abcd1234';
    mkdirSync(join(preservation, name));
    expect(() =>
      preflightFullRootRetain({
        primaryCheckoutRoot: checkout,
        preservationParentDirectory: preservation,
        artifactName: name,
      }),
    ).toThrow(/artifact_exists/);
  });

  it('refuses when ATLAS_STATE_ROOT_REQUIRED is set', () => {
    const checkout = tempDir();
    writeCheckoutFixture(checkout);
    const preservation = tempDir();
    const previous = process.env.ATLAS_STATE_ROOT_REQUIRED;
    try {
      process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
      expect(() =>
        preflightFullRootRetain({
          primaryCheckoutRoot: checkout,
          preservationParentDirectory: preservation,
          artifactName: 'atlas-full-root-m3d-20260801T120002Z-abcd1234',
        }),
      ).toThrow(FullRootRehearsalError);
    } finally {
      if (previous === undefined) delete process.env.ATLAS_STATE_ROOT_REQUIRED;
      else process.env.ATLAS_STATE_ROOT_REQUIRED = previous;
    }
  });
});

describe('assembleLiveFullRoot', () => {
  it('copies present stores and writes empty-policy markers for the rest', () => {
    const checkout = tempDir('atlas-retain-assemble-');
    writeCheckoutFixture(checkout);
    const destination = join(tempDir(), 'assembled');
    const manifest = assembleLiveFullRoot(checkout, destination);
    expect(manifest.stores).toHaveLength(AUTHORITATIVE_FULL_ROOT_STORES.length);
    expect(existsSync(join(destination, 'exec-graph'))).toBe(true);
    expect(existsSync(join(destination, 'goal-budgets', 'goal-budgets.empty-policy.json'))).toBe(
      true,
    );
    const emptyPolicies = manifest.stores.filter((s) => s.policy === 'empty-policy');
    expect(emptyPolicies.length).toBeGreaterThan(0);
  });

  it('refuses to assemble under the checkout root', () => {
    const checkout = tempDir();
    writeCheckoutFixture(checkout);
    expect(() => assembleLiveFullRoot(checkout, join(checkout, 'evil'))).toThrow(
      /path_invalid/,
    );
  });
});

describe('retainAndRehearseFullRoot', () => {
  it('retains, rehearses, verifies, and leaves a bound artifact', () => {
    const checkout = tempDir('atlas-retain-e2e-checkout-');
    writeCheckoutFixture(checkout);
    // Override task-results by creating the hardcoded path? That would touch
    // C:/Projects/ATLAS — refuse. Instead patch env is not available; the
    // plan uses hardcoded path. For unit isolation, assemble via retain which
    // will empty-policy task-results if the live path is empty/missing OR
    // copy if present. Presence of C:/Projects/ATLAS/data/task-results is OK
    // to read (read-only) in this test environment.
    const preservation = tempDir('atlas-retain-e2e-parent-');
    const stagingParent = tempDir('atlas-retain-e2e-staging-');
    const artifactName = 'atlas-full-root-m3d-20260801T120003Z-deadbeef';

    const result = retainAndRehearseFullRoot({
      primaryCheckoutRoot: checkout,
      preservationParentDirectory: preservation,
      artifactName,
      stagingParentDirectory: stagingParent,
      porcelainPaths: [],
      liveInvariance: 'checkout',
    });

    expect(result.verified.verified).toBe(true);
    expect(result.liveSourcesUnchanged).toBe(true);
    expect(result.receipt.rollbackVerified).toBe(true);
    expect(
      existsSync(join(preservation, artifactName, 'retained-root', 'exec-graph')),
    ).toBe(true);
    expect(
      existsSync(join(preservation, artifactName, 'rehearsal-receipt.json')),
    ).toBe(true);
    expect(existsSync(join(preservation, artifactName, 'preflight.json'))).toBe(
      true,
    );
  });
});
