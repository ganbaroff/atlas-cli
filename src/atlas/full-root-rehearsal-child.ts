/**
 * Cold child for full-root rehearsal.
 * Usage: node --import tsx full-root-rehearsal-child.ts <absolute-candidate-root>
 *
 * Prints a JSON FullRootInspection-like payload on stdout. Intended to run
 * under forbid-network.mjs via NODE_OPTIONS.
 */

import { inspectFullRoot } from './full-root-rehearsal.js';

const root = process.argv[2];
if (!root) {
  process.stderr.write('usage: full-root-rehearsal-child.ts <absolute-candidate-root>\n');
  process.exit(2);
}

const inspection = inspectFullRoot(root);
process.stdout.write(
  `${JSON.stringify({
    root: inspection.root,
    treeSha256: inspection.treeSha256,
    stores: inspection.stores,
    networkDenied: true,
  })}\n`,
);
