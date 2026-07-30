/**
 * Cold-replay entry point for M3B rehearsals.
 *
 * This file is executed as a brand-new child process (see
 * `coldReplayExecGraphDirectory` in `shadow-rehearsal.ts`) — it shares no
 * module state with the parent process. Its only job is to read the shadow
 * root passed as `argv[2]`, rebuild state from the ledger via the existing
 * M3A inspector, and print the inspection as JSON on stdout. Any failure is
 * reported on stderr with a non-zero exit code; the parent treats silence,
 * a non-zero exit, or unparseable stdout as a failed rehearsal — never as a
 * pass.
 */

import { inspectExecGraphDirectory } from './shadow-state.js';

function main(): void {
  const directory = process.argv[2];
  if (!directory) {
    console.error('shadow-rehearsal-child: missing shadow root argument');
    process.exit(1);
  }

  const inspection = inspectExecGraphDirectory(directory);
  process.stdout.write(JSON.stringify(inspection));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
