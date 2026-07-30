import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

import {
  preserveExecGraphSnapshot,
  PreservedStateRehearsalError,
  rehearsePreservedExecGraph,
  verifyPreservedStateRehearsal,
} from '../src/atlas/preserved-state-rehearsal.js';

type CliCommand =
  | {
      readonly mode: 'run';
      readonly sourceDirectory: string;
      readonly preservationParentDirectory: string;
      readonly artifactName: string;
    }
  | {
      readonly mode: 'verify';
      readonly artifactDirectory: string;
    };

function pathInvalid(message: string): never {
  throw new PreservedStateRehearsalError('path_invalid', message);
}

function parseCommand(args: readonly string[]): CliCommand {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        source: { type: 'string' },
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
    const sourceDirectory = parsed.values.source;
    const preservationParentDirectory = parsed.values['preservation-parent'];
    const artifactName = parsed.values['artifact-name'];
    if (
      typeof sourceDirectory !== 'string' ||
      sourceDirectory.length === 0 ||
      typeof preservationParentDirectory !== 'string' ||
      preservationParentDirectory.length === 0 ||
      typeof artifactName !== 'string' ||
      artifactName.length === 0 ||
      parsed.values.artifact !== undefined
    ) {
      pathInvalid(
        'run requires only --source, --preservation-parent, and --artifact-name',
      );
    }
    if (!isAbsolute(sourceDirectory) || !isAbsolute(preservationParentDirectory)) {
      pathInvalid('run source and preservation parent must be absolute paths');
    }
    return {
      mode,
      sourceDirectory,
      preservationParentDirectory,
      artifactName,
    };
  }

  if (mode === 'verify') {
    const artifactDirectory = parsed.values.artifact;
    if (
      typeof artifactDirectory !== 'string' ||
      artifactDirectory.length === 0 ||
      parsed.values.source !== undefined ||
      parsed.values['preservation-parent'] !== undefined ||
      parsed.values['artifact-name'] !== undefined
    ) {
      pathInvalid('verify requires only --artifact');
    }
    if (!isAbsolute(artifactDirectory)) {
      pathInvalid('verify artifact must be an absolute path');
    }
    return { mode, artifactDirectory };
  }

  pathInvalid('unknown mode; expected run or verify');
}

function run(command: CliCommand): void {
  if (command.mode === 'run') {
    const manifest = preserveExecGraphSnapshot({
      sourceDirectory: command.sourceDirectory,
      preservationParentDirectory: command.preservationParentDirectory,
      artifactName: command.artifactName,
    });
    rehearsePreservedExecGraph({ artifactDirectory: manifest.artifactDirectory });
    const verified = verifyPreservedStateRehearsal(manifest.artifactDirectory);
    console.log(
      JSON.stringify({
        status: 'accepted',
        artifactDirectory: verified.receipt.artifactDirectory,
        manifestSha256: verified.manifestSha256,
        eventCount: verified.receipt.eventCount,
        goalCount: verified.receipt.goalCount,
        taskCount: verified.receipt.taskCount,
        rollbackVerified: verified.receipt.rollbackVerified,
        workDirectoryAbsent: verified.receipt.workDirectoryAbsent,
      }),
    );
    return;
  }

  const verified = verifyPreservedStateRehearsal(command.artifactDirectory);
  console.log(
    JSON.stringify({
      status: 'verified',
      artifactDirectory: verified.receipt.artifactDirectory,
      manifestSha256: verified.manifestSha256,
      eventCount: verified.receipt.eventCount,
      goalCount: verified.receipt.goalCount,
      taskCount: verified.receipt.taskCount,
      verified: verified.verified,
    }),
  );
}

try {
  run(parseCommand(process.argv.slice(2)));
} catch (error) {
  const refusal =
    error instanceof PreservedStateRehearsalError
      ? { code: error.code, message: error.message }
      : {
          code: 'unexpected_error',
          message: error instanceof Error ? error.message : String(error),
        };
  console.error(JSON.stringify({ status: 'refused', ...refusal }));
  process.exitCode = 1;
}
