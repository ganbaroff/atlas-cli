/**
 * Sprint 3 — service-to-service auth for learning HTTP API.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export class LearningAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningAuthError';
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Verify Bearer token against ATLAS_LEARNING_API_KEY. Fail-closed in production. */
export function verifyLearningApiAuth(req: IncomingMessage): void {
  const expected = process.env.ATLAS_LEARNING_API_KEY ?? '';
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      throw new LearningAuthError('ATLAS_LEARNING_API_KEY not configured');
    }
    return;
  }
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    throw new LearningAuthError('missing Bearer token');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token || !safeEqual(token, expected)) {
    throw new LearningAuthError('invalid Bearer token');
  }
}
