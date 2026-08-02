#!/usr/bin/env node
/**
 * P1 stub for `npm run eval:critical`.
 * No CLI, network, scheduler, queue, or filesystem mutation beyond stdout.
 */
console.log(
  JSON.stringify({
    ok: true,
    stub: true,
    phase: 'P1',
    message: 'TODO P3: implement critical evals E01–E03; E04/E05 later',
    ran: [],
    sideEffects: 'none',
  }),
);
process.exit(0);
