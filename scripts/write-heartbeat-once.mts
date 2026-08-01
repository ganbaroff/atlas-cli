import { writeHeartbeat } from '../src/atlas/memory-manager.js';

await writeHeartbeat({
  source: 'jarvis-cli-smoke',
  note: 'S4 live smoke 2026-08-01',
  pid: process.pid,
});
console.log('heartbeat-written');
