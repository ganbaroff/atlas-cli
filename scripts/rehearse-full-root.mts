/**
 * M3D Task 5 CLI — retain current authoritative stores and rehearse the copy.
 *
 * run:  --primary-checkout --preservation-parent --artifact-name
 * verify: --artifact
 *
 * Never activates live state. Never prints secret values.
 */

import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

import {
  FullRootRehearsalError,
  verifyFullRootRehearsal,
} from '../src/atlas/full-root-rehearsal.js';
import { retainAndRehearseFullRoot } from '../src/atlas/full-root-retain.js';

type CliCommand =
  | {
      readonly mode: 'run';
      readonly primaryCheckoutRoot: string;
      readonly preservationParentDirectory: string;
      readonly artifactName: string;
    }
  | {
      readonly mode: 'verify';
      readonly artifactDirectory: string;
    };

function pathInvalid(message: string): never {
  throw new FullRootRehearsalError('path_invalid', message);
}

function readPorcelainPaths(checkoutRoot: string): string[] {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=v1'],
    { cwd: checkoutRoot, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    pathInvalid(
      `unable to read git status for primary checkout: ${(result.stderr || '').slice(0, 200)}`,
    );
  }
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).replace(/\\/g, '/'));
}

function parseCommand(args: readonly string[]): CliCommand {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        'primary-checkout': { type: 'string' },
        'preservation-parent': { type: 'string' },
        'artifact-name': { type: 'string' },
        artifact: { type: 'string' },
      },
    });
  } catch {
    pathInvalid('invalid CLI arguments');
  }

  if (parsed.positionals.length !== 1) {
    pathInvalid('expected exactly one mode: run or verify');
  }
  const mode = parsed.positionals[0];
  if (mode === 'run') {
    const primaryCheckoutRoot = parsed.values['primary-checkout'];
    const preservationParentDirectory = parsed.values['preservation-parent'];
    const artifactName = parsed.values['artifact-name'];
    if (
      typeof primaryCheckoutRoot !== 'string' ||
      primaryCheckoutRoot.length === 0 ||
      typeof preservationParentDirectory !== 'string' ||
      preservationParentDirectory.length === 0 ||
      typeof artifactName !== 'string' ||
      artifactName.length === 0 ||
      parsed.values.artifact !== undefined
    ) {
      pathInvalid(
        'run requires only --primary-checkout, --preservation-parent, and --artifact-name',
      );
    }
    if (!isAbsolute(primaryCheckoutRoot) || !isAbsolute(preservationParentDirectory)) {
      pathInvalid('run paths must be absolute');
    }
    return {
      mode,
      primaryCheckoutRoot,
      preservationParentDirectory,
      artifactName,
    };
  }

  if (mode === 'verify') {
    const artifactDirectory = parsed.values.artifact;
    if (
      typeof artifactDirectory !== 'string' ||
      artifactDirectory.length === 0 ||
      parsed.values['primary-checkout'] !== undefined ||
      parsed.values['preservation-parent'] !== undefined ||
      parsed.values['artifact-name'] !== undefined
    ) {
      pathInvalid('verify requires only --artifact');
    }
    if (!isAbsolute(artifactDirectory)) {
      pathInvalid('verify artifact must be absolute');
    }
    return { mode, artifactDirectory };
  }

  pathInvalid('unknown mode; expected run or verify');
}

function run(command: CliCommand): void {
  if (command.mode === 'run') {
    const porcelainPaths = readPorcelainPaths(command.primaryCheckoutRoot);
    const result = retainAndRehearseFullRoot({
      primaryCheckoutRoot: command.primaryCheckoutRoot,
      preservationParentDirectory: command.preservationParentDirectory,
      artifactName: command.artifactName,
      porcelainPaths,
    });
    console.log(
      JSON.stringify({
        status: 'accepted',
        artifactDirectory: result.receipt.artifactDirectory,
        retainedRoot: result.assemble.retainedRoot,
        sourceTreeSha256: result.receipt.sourceTreeSha256,
        storeCount: result.receipt.storeCount,
        emptyPolicyStores: result.assemble.stores
          .filter((s) => s.policy === 'empty-policy')
          .map((s) => s.store),
        copiedStores: result.assemble.stores
          .filter((s) => s.policy === 'copied')
          .map((s) => s.store),
        rollbackVerified: result.receipt.rollbackVerified,
        liveSourcesUnchanged: result.liveSourcesUnchanged,
        verified: result.verified.verified,
      }),
    );
    return;
  }

  const verified = verifyFullRootRehearsal(command.artifactDirectory);
  console.log(
    JSON.stringify({
      status: 'verified',
      artifactDirectory: verified.receipt.artifactDirectory,
      sourceTreeSha256: verified.receipt.sourceTreeSha256,
      storeCount: verified.receipt.storeCount,
      verified: verified.verified,
    }),
  );
}

try {
  run(parseCommand(process.argv.slice(2)));
} catch (error) {
  const refusal =
    error instanceof FullRootRehearsalError
      ? { code: error.code, message: error.message }
      : {
          code: 'unexpected_error',
          message: error instanceof Error ? error.message : String(error),
        };
  console.error(JSON.stringify({ status: 'refused', ...refusal }));
  process.exitCode = 1;
}
