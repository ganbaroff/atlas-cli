/**
 * Child-process crash fixture for the effect journal.
 *
 * Modes:
 *   crash-before-effect  — prepare only, then exit(1) before markStarted
 *   crash-after-start    — prepare + markStarted, then exit(1) before effect
 *   crash-after-receipt  — full success receipt flushed, then exit(1)
 *
 * Usage: node --import tsx effect-journal-crash-child.ts <mode> <rootDir> <operationId>
 */

import {
  markStarted,
  markSucceeded,
  prepareOperation,
} from '../../atlas/effect-journal.js';

const [mode, rootDir, operationId] = process.argv.slice(2);

if (
  !mode ||
  !rootDir ||
  !operationId ||
  !['crash-before-effect', 'crash-after-start', 'crash-after-receipt'].includes(mode)
) {
  process.stderr.write(
    'usage: effect-journal-crash-child.ts <mode> <rootDir> <operationId>\n',
  );
  process.exit(2);
}

const commandId = operationId.includes('queue:')
  ? operationId.slice('queue:'.length)
  : operationId;

prepareOperation(operationId, {
  identity: { kind: 'queue-command', commandId },
  rootDir,
});

if (mode === 'crash-before-effect') {
  process.exit(1);
}

markStarted(operationId, { rootDir });

if (mode === 'crash-after-start') {
  process.exit(1);
}

markSucceeded(operationId, { output: 'child-receipt-ok' }, { rootDir });
process.exit(1);
