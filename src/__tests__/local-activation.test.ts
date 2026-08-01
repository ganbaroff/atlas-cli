/**
 * S4 LOCAL activation — disposable fixture tests only.
 */

import { createHash } from 'node:crypto';
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
  LOCAL_ACTIVATION_EXECUTE_TOKEN,
  LOCAL_ACTIVATION_RECEIPT_KIND,
  installLocalActivationBinding,
  prepareLocalActivationRoot,
  verifyPreparedLocalActivation,
} from '../atlas/local-activation.js';
import { seedFixtureFullRoot } from '../atlas/full-root-rehearsal.js';
import { STATE_STORES, resolveStateDir } from '../atlas/state-root.js';

const tempRoots: string[] = [];

function tempDir(prefix = 'atlas-s4-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  delete process.env[LOCAL_ACTIVATION_EXECUTE_TOKEN];
  delete process.env.ATLAS_STATE_ROOT;
  delete process.env.ATLAS_STATE_ROOT_REQUIRED;
  delete process.env.ATLAS_NODE_ROLE;
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
}

function seedReceipt(path: string): string {
  const body = `${JSON.stringify({
    schemaVersion: 1,
    kind: 'atlas.m3d-full-root-rehearsal',
    fixture: true,
  })}\n`;
  writeFileSync(path, body);
  return createHash('sha256').update(body).digest('hex');
}

describe('prepareLocalActivationRoot', () => {
  it('assembles, installs receipt+manifest, and verifies under REQUIRED', () => {
    const checkout = tempDir('atlas-s4-checkout-');
    writeCheckoutFixture(checkout);
    const receiptPath = join(tempDir(), 'rehearsal-receipt.json');
    const receiptSha = seedReceipt(receiptPath);
    const destination = join(tempDir('atlas-s4-dest-'), 'root');

    const packet = prepareLocalActivationRoot({
      primaryCheckoutRoot: checkout,
      destinationRoot: destination,
      rehearsalReceiptPath: receiptPath,
    });

    expect(packet.nodeRole).toBe('local');
    expect(packet.receiptKind).toBe(LOCAL_ACTIVATION_RECEIPT_KIND);
    expect(packet.receiptSha256).toBe(receiptSha);
    expect(packet.stores).toEqual(Object.keys(STATE_STORES).sort());
    expect(existsSync(join(destination, 'state-root-activation.json'))).toBe(
      true,
    );
    expect(
      existsSync(join(destination, 'activation-receipts', LOCAL_ACTIVATION_RECEIPT_KIND)),
    ).toBe(true);
    expect(existsSync(packet.bindingCmdPath)).toBe(true);
    expect(readFileSync(packet.bindingCmdPath, 'utf8')).toContain(
      'ATLAS_STATE_ROOT_REQUIRED=1',
    );
    expect(readFileSync(packet.rollbackCmdPath, 'utf8')).toContain(
      'ATLAS_STATE_ROOT_REQUIRED=0',
    );

    verifyPreparedLocalActivation(destination);
    process.env.ATLAS_STATE_ROOT = destination;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    process.env.ATLAS_NODE_ROLE = 'local';
    expect(resolveStateDir('exec-graph')).toBe(join(destination, 'exec-graph'));
  });

  it('refuses destinations under ~/.atlas', () => {
    const checkout = tempDir('atlas-s4-checkout-');
    writeCheckoutFixture(checkout);
    const receiptPath = join(tempDir(), 'rehearsal-receipt.json');
    seedReceipt(receiptPath);
    expect(() =>
      prepareLocalActivationRoot({
        primaryCheckoutRoot: checkout,
        destinationRoot: join(
          process.env.USERPROFILE ?? 'C:\\Users\\user',
          '.atlas',
          'evil-root',
        ),
        rehearsalReceiptPath: receiptPath,
      }),
    ).toThrow(/live_path_refused/);
  });

  it('refuses install without the execute token', () => {
    const checkout = tempDir('atlas-s4-checkout-');
    writeCheckoutFixture(checkout);
    const receiptPath = join(tempDir(), 'rehearsal-receipt.json');
    seedReceipt(receiptPath);
    const destination = join(tempDir('atlas-s4-dest-'), 'root');
    const packet = prepareLocalActivationRoot({
      primaryCheckoutRoot: checkout,
      destinationRoot: destination,
      rehearsalReceiptPath: receiptPath,
    });
    delete process.env[LOCAL_ACTIVATION_EXECUTE_TOKEN];
    expect(() =>
      installLocalActivationBinding(packet, tempDir('atlas-s4-wrapper-')),
    ).toThrow(/token_missing/);
  });

  it('installs wrapper binding with the execute token', () => {
    const checkout = tempDir('atlas-s4-checkout-');
    writeCheckoutFixture(checkout);
    const receiptPath = join(tempDir(), 'rehearsal-receipt.json');
    seedReceipt(receiptPath);
    const destination = join(tempDir('atlas-s4-dest-'), 'root');
    const packet = prepareLocalActivationRoot({
      primaryCheckoutRoot: checkout,
      destinationRoot: destination,
      rehearsalReceiptPath: receiptPath,
    });
    const wrapperDir = tempDir('atlas-s4-wrapper-');
    process.env[LOCAL_ACTIVATION_EXECUTE_TOKEN] = '1';
    const installed = installLocalActivationBinding(packet, wrapperDir);
    expect(existsSync(installed.wrapperPath)).toBe(true);
    expect(readFileSync(installed.wrapperPath, 'utf8')).toContain(destination);
    expect(existsSync(installed.rollbackPath)).toBe(true);
  });
});
