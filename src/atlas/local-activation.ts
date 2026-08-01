/**
 * S4 — LOCAL state-root activation (not physical cutover).
 *
 * Assembles a disposable or live-candidate root from current legacy stores,
 * installs a byte-verified M3D full-root rehearsal receipt, writes the
 * activation manifest, and emits a recorded binding + rollback packet.
 *
 * Enabling the live wrapper binding requires ATLAS_LOCAL_ACTIVATION_EXECUTE=1.
 * Railway / scheduler / code-root moves are out of scope.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import {
  assembleLiveFullRoot,
  type AssembleManifest,
} from './full-root-retain.js';
import {
  LOCAL_ACTIVATION_RECEIPT_KIND,
  STATE_ROOT_ACTIVATION_FILE,
  STATE_STORES,
  assertStateRootActivated,
  resolveStateDir,
  type StateStore,
} from './state-root.js';

export { LOCAL_ACTIVATION_RECEIPT_KIND };
export const LOCAL_ACTIVATION_EXECUTE_TOKEN = 'ATLAS_LOCAL_ACTIVATION_EXECUTE';
export const LOCAL_ACTIVATION_WRAPPER_BASENAME = 'local-activation.cmd';
export const LOCAL_ACTIVATION_ROLLBACK_BASENAME = 'local-activation.rollback.cmd';

export type LocalActivationErrorCode =
  | 'path_invalid'
  | 'path_escape'
  | 'receipt_invalid'
  | 'token_missing'
  | 'live_path_refused'
  | 'already_exists'
  | 'activation_failed';

export class LocalActivationError extends Error {
  constructor(
    readonly code: LocalActivationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'LocalActivationError';
  }
}

function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new LocalActivationError('path_invalid', `${label} must be absolute`);
  }
  return resolve(path);
}

function refuseUnderLiveRoots(destination: string): void {
  const banned = [
    resolve('C:/Users/user/OneDrive/Documents/GitHub/ANUS'),
    resolve('C:/Projects/ATLAS'),
    resolve(homedir(), '.atlas'),
  ];
  const dest = resolve(destination);
  for (const ban of banned) {
    if (dest === ban || dest.startsWith(`${ban}${sep}`)) {
      throw new LocalActivationError(
        'live_path_refused',
        `activation destination must not be under ${ban}`,
      );
    }
  }
}

function sha256Bytes(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function allStores(): StateStore[] {
  return (Object.keys(STATE_STORES) as StateStore[]).sort();
}

export interface PrepareLocalActivationInput {
  readonly primaryCheckoutRoot: string;
  readonly destinationRoot: string;
  /** Absolute path to Task 5 `rehearsal-receipt.json` (or fixture bytes). */
  readonly rehearsalReceiptPath: string;
}

export interface LocalActivationPacket {
  readonly schemaVersion: 1;
  readonly kind: 'atlas.s4-local-activation';
  readonly preparedAt: string;
  readonly nodeRole: 'local';
  readonly stateRoot: string;
  readonly receiptKind: typeof LOCAL_ACTIVATION_RECEIPT_KIND;
  readonly receiptSha256: string;
  readonly assemble: AssembleManifest;
  readonly stores: StateStore[];
  readonly bindingCmdPath: string;
  readonly rollbackCmdPath: string;
  readonly packetPath: string;
}

function writeBindingCmd(stateRoot: string, outPath: string): void {
  const body = [
    '@echo off',
    'REM Atlas S4 LOCAL activation binding - generated; no secrets',
    `set "ATLAS_NODE_ROLE=local"`,
    `set "ATLAS_STATE_ROOT=${stateRoot}"`,
    `set "ATLAS_STATE_ROOT_REQUIRED=1"`,
    '',
  ].join('\r\n');
  writeFileSync(outPath, body);
}

function writeRollbackCmd(outPath: string): void {
  const body = [
    '@echo off',
    `REM Atlas S4 LOCAL activation rollback — clears required activation`,
    `set "ATLAS_STATE_ROOT_REQUIRED=0"`,
    `set "ATLAS_NODE_ROLE="`,
    `set "ATLAS_STATE_ROOT="`,
    '',
  ].join('\r\n');
  writeFileSync(outPath, body);
}

/**
 * Assemble stores, install receipt + manifest, emit binding/rollback cmds.
 * Does not touch the live runner wrapper.
 */
export function prepareLocalActivationRoot(
  input: PrepareLocalActivationInput,
): LocalActivationPacket {
  const checkout = requireAbsolute(input.primaryCheckoutRoot, 'primaryCheckoutRoot');
  const destination = requireAbsolute(input.destinationRoot, 'destinationRoot');
  const receiptPath = requireAbsolute(
    input.rehearsalReceiptPath,
    'rehearsalReceiptPath',
  );
  refuseUnderLiveRoots(destination);
  if (existsSync(destination)) {
    throw new LocalActivationError(
      'already_exists',
      `destination already exists: ${destination}`,
    );
  }
  if (!existsSync(receiptPath)) {
    throw new LocalActivationError(
      'receipt_invalid',
      `rehearsal receipt missing: ${receiptPath}`,
    );
  }

  const assemble = assembleLiveFullRoot(checkout, destination);
  for (const store of allStores()) {
    mkdirSync(join(destination, store), { recursive: true });
  }

  const receiptBytes = readFileSync(receiptPath);
  const receiptSha256 = sha256Bytes(receiptBytes);
  const receiptsDir = join(destination, 'activation-receipts');
  mkdirSync(receiptsDir, { recursive: true });
  const installedReceipt = join(receiptsDir, LOCAL_ACTIVATION_RECEIPT_KIND);
  writeFileSync(installedReceipt, receiptBytes);
  // Keep M3C kind alias so older tips that only allowlist m3c can verify
  // the same bytes after merge; this tip accepts either kind.
  writeFileSync(
    join(receiptsDir, 'm3c-preserved-state-rehearsal'),
    receiptBytes,
  );

  const activatedAt = new Date().toISOString();
  const stores = allStores();
  const manifest = {
    schemaVersion: 1 as const,
    nodeRole: 'local' as const,
    activatedAt,
    stores,
    sourceReceipts: [
      { kind: LOCAL_ACTIVATION_RECEIPT_KIND, sha256: receiptSha256 },
      { kind: 'm3c-preserved-state-rehearsal', sha256: receiptSha256 },
    ],
  };
  writeFileSync(
    join(destination, STATE_ROOT_ACTIVATION_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const bindingCmdPath = join(destination, LOCAL_ACTIVATION_WRAPPER_BASENAME);
  const rollbackCmdPath = join(destination, LOCAL_ACTIVATION_ROLLBACK_BASENAME);
  writeBindingCmd(destination, bindingCmdPath);
  writeRollbackCmd(rollbackCmdPath);

  const packet: LocalActivationPacket = {
    schemaVersion: 1,
    kind: 'atlas.s4-local-activation',
    preparedAt: activatedAt,
    nodeRole: 'local',
    stateRoot: destination,
    receiptKind: LOCAL_ACTIVATION_RECEIPT_KIND,
    receiptSha256,
    assemble,
    stores,
    bindingCmdPath,
    rollbackCmdPath,
    packetPath: join(destination, 'local-activation-packet.json'),
  };
  writeFileSync(packet.packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  return packet;
}

/**
 * Prove the prepared root activates under required mode (caller supplies env).
 */
export function verifyPreparedLocalActivation(stateRoot: string): void {
  const root = requireAbsolute(stateRoot, 'stateRoot');
  const previous = {
    ATLAS_STATE_ROOT: process.env.ATLAS_STATE_ROOT,
    ATLAS_STATE_ROOT_REQUIRED: process.env.ATLAS_STATE_ROOT_REQUIRED,
    ATLAS_NODE_ROLE: process.env.ATLAS_NODE_ROLE,
  };
  try {
    process.env.ATLAS_STATE_ROOT = root;
    process.env.ATLAS_STATE_ROOT_REQUIRED = '1';
    process.env.ATLAS_NODE_ROLE = 'local';
    const activation = assertStateRootActivated(root);
    if (activation.nodeRole !== 'local') {
      throw new LocalActivationError('activation_failed', 'nodeRole not local');
    }
    for (const store of allStores()) {
      const dir = resolveStateDir(store);
      if (!(dir === join(root, store) || dir.startsWith(`${root}${sep}`))) {
        throw new LocalActivationError(
          'path_escape',
          `store ${store} resolved outside activated root: ${dir}`,
        );
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function requireExecuteToken(): void {
  const value = (process.env[LOCAL_ACTIVATION_EXECUTE_TOKEN] ?? '').trim();
  if (value !== '1') {
    throw new LocalActivationError(
      'token_missing',
      `${LOCAL_ACTIVATION_EXECUTE_TOKEN}=1 required to install the live wrapper binding`,
    );
  }
}

export interface InstallLocalActivationBindingResult {
  readonly wrapperPath: string;
  readonly installedFrom: string;
  readonly rollbackPath: string;
}

/**
 * Install `~/.atlas/local-activation.cmd` from a prepared packet.
 * Does not start/stop the runner and does not change Railway/scheduler.
 */
export function installLocalActivationBinding(
  packet: LocalActivationPacket,
  wrapperDir = join(homedir(), '.atlas'),
): InstallLocalActivationBindingResult {
  requireExecuteToken();
  verifyPreparedLocalActivation(packet.stateRoot);
  mkdirSync(wrapperDir, { recursive: true });
  const wrapperPath = join(wrapperDir, LOCAL_ACTIVATION_WRAPPER_BASENAME);
  const rollbackPath = join(wrapperDir, LOCAL_ACTIVATION_ROLLBACK_BASENAME);
  if (existsSync(wrapperPath)) {
    const backup = `${wrapperPath}.bak-${Date.now()}`;
    renameSync(wrapperPath, backup);
  }
  copyFileSync(packet.bindingCmdPath, wrapperPath);
  copyFileSync(packet.rollbackCmdPath, rollbackPath);
  return {
    wrapperPath,
    installedFrom: packet.bindingCmdPath,
    rollbackPath,
  };
}

/** Render a one-line include snippet for start-runner.cmd. */
export function renderStartRunnerIncludeSnippet(): string {
  return [
    `REM S4 LOCAL activation binding (optional; absent = legacy paths)`,
    `if exist "%USERPROFILE%\\.atlas\\${LOCAL_ACTIVATION_WRAPPER_BASENAME}" (`,
    `  call "%USERPROFILE%\\.atlas\\${LOCAL_ACTIVATION_WRAPPER_BASENAME}"`,
    `)`,
  ].join('\r\n');
}

export function defaultLiveActivationDestination(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return join(
    'C:\\Projects\\VOLAURA\\memory\\atlas\\state-roots',
    `local-${stamp}`,
  );
}
