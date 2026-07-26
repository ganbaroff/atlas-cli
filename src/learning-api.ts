/**
 * Cloud Run entrypoint — Atlas learning HTTP API only.
 */

import { startLearningHttpServer } from './learning/http-server.js';

const port = Number(process.env.PORT ?? 8080);
startLearningHttpServer({ port, host: '0.0.0.0' });
console.log(`[atlas-learning-api] listening on :${port}`);
