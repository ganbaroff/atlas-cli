/**
 * M5 / M4-debt — enforce ATLAS_READONLY on mutating paths.
 */

export class ReadonlyModeError extends Error {
  constructor(action: string) {
    super(`ATLAS_READONLY=1 — refusing mutating action: ${action}`);
    this.name = 'ReadonlyModeError';
  }
}

export function isAtlasReadonly(): boolean {
  return process.env.ATLAS_READONLY === '1' || process.env.ATLAS_READONLY === 'true';
}

/** Throw if this process is in instance readonly mode. */
export function assertWritable(action: string): void {
  if (isAtlasReadonly()) throw new ReadonlyModeError(action);
}
