/**
 * S4 — prepare (and optionally install) LOCAL state-root activation.
 *
 * Default: prepare only (assemble root + packet + binding cmds).
 * With --install and ATLAS_LOCAL_ACTIVATION_EXECUTE=1: install ~/.atlas
 * local-activation.cmd from a prepared packet. Does not restart the runner,
 * Railway, or scheduler.
 *
 * Usage:
 *   npx tsx scripts/activate-local-state-root.mts
 *   npx tsx scripts/activate-local-state-root.mts --install --packet <path>
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  LOCAL_ACTIVATION_EXECUTE_TOKEN,
  defaultLiveActivationDestination,
  installLocalActivationBinding,
  prepareLocalActivationRoot,
  verifyPreparedLocalActivation,
  type LocalActivationPacket,
} from '../src/atlas/local-activation.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

const primaryCheckout =
  argValue('--checkout') ??
  'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS';
const receiptPath =
  argValue('--receipt') ??
  'C:\\Projects\\VOLAURA\\memory\\atlas\\preservation\\atlas-full-root-m3d-20260731T234811Z-bf74158c\\rehearsal-receipt.json';
const packetPathArg = argValue('--packet');
const destination =
  argValue('--destination') ?? defaultLiveActivationDestination();
const doInstall = process.argv.includes('--install');

let packet: LocalActivationPacket;

if (packetPathArg) {
  const packetPath = resolve(packetPathArg);
  if (!existsSync(packetPath)) {
    console.error(`packet missing: ${packetPath}`);
    process.exit(2);
  }
  packet = JSON.parse(readFileSync(packetPath, 'utf8')) as LocalActivationPacket;
  verifyPreparedLocalActivation(packet.stateRoot);
  console.log(
    JSON.stringify(
      {
        phase: 'loaded-packet',
        stateRoot: packet.stateRoot,
        packetPath,
      },
      null,
      2,
    ),
  );
} else {
  if (!existsSync(primaryCheckout)) {
    console.error(`checkout missing: ${primaryCheckout}`);
    process.exit(2);
  }
  if (!existsSync(receiptPath)) {
    console.error(`receipt missing: ${receiptPath}`);
    process.exit(2);
  }

  console.log(
    JSON.stringify(
      {
        phase: 'prepare',
        primaryCheckout: resolve(primaryCheckout),
        receiptPath: resolve(receiptPath),
        destination: resolve(destination),
        install: doInstall,
      },
      null,
      2,
    ),
  );

  packet = prepareLocalActivationRoot({
    primaryCheckoutRoot: primaryCheckout,
    destinationRoot: destination,
    rehearsalReceiptPath: receiptPath,
  });
  verifyPreparedLocalActivation(packet.stateRoot);

  console.log(
    JSON.stringify(
      {
        phase: 'prepared',
        stateRoot: packet.stateRoot,
        receiptSha256: packet.receiptSha256,
        packetPath: packet.packetPath,
        bindingCmdPath: packet.bindingCmdPath,
        rollbackCmdPath: packet.rollbackCmdPath,
        storeCount: packet.stores.length,
      },
      null,
      2,
    ),
  );
}

if (!doInstall) {
  console.log(
    JSON.stringify({
      phase: 'done',
      installed: false,
      next: `Set ${LOCAL_ACTIVATION_EXECUTE_TOKEN}=1 and re-run with --install --packet <packetPath>`,
    }),
  );
  process.exit(0);
}

const installed = installLocalActivationBinding(packet);
console.log(
  JSON.stringify(
    {
      phase: 'installed',
      wrapperPath: installed.wrapperPath,
      rollbackPath: installed.rollbackPath,
      note: 'Runner picks this up on next start-runner.cmd launch. Railway untouched. Physical cutover still NO-GO.',
    },
    null,
    2,
  ),
);
