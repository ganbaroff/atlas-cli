import { captureScreen } from '../src/atlas/screen-capture.ts';

const result = await captureScreen({ outDir: process.env.TEMP + '/atlas-captures-smoke' });
console.log(JSON.stringify({ ok: true, width: result.width, height: result.height, bytes: result.bytes, path: result.path }, null, 2));
