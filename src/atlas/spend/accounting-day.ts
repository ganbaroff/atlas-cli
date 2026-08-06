/**
 * atlas/spend/accounting-day.ts — deterministic day rollover (P1-B wave 1).
 *
 * Pure function: given an instant and an IANA timezone, returns the
 * YYYY-MM-DD accounting day that instant falls on IN THAT TIMEZONE. No
 * process-wide clock, no hidden `new Date()` — every caller injects `now`
 * explicitly so a restart near local midnight attributes spend to the same
 * day a non-restarted process would have.
 */

export class InvalidTimezoneError extends Error {
  constructor(ianaTimezone: string, cause: unknown) {
    super(`invalid IANA timezone: ${JSON.stringify(ianaTimezone)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'InvalidTimezoneError';
  }
}

/** Throws InvalidTimezoneError for a timezone Intl cannot resolve. */
function partsFormatter(ianaTimezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch (error) {
    throw new InvalidTimezoneError(ianaTimezone, error);
  }
}

/**
 * Compute the YYYY-MM-DD accounting day for `instant` in `ianaTimezone`.
 * Deterministic and side-effect-free — the only inputs are the two
 * arguments, so the same pair always produces the same day string.
 */
export function computeAccountingDay(instant: Date, ianaTimezone: string): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new InvalidTimezoneError(ianaTimezone, new Error('instant must be a valid Date'));
  }
  const parts = partsFormatter(ianaTimezone).formatToParts(instant);
  const byType = Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<'year' | 'month' | 'day', string>;
  return `${byType.year}-${byType.month}-${byType.day}`;
}

/** The accounting day immediately before `accountingDay` (plain calendar-day arithmetic, timezone-agnostic once you already have a YYYY-MM-DD string). */
export function previousAccountingDay(accountingDay: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(accountingDay);
  if (!match) throw new Error(`previousAccountingDay: not a YYYY-MM-DD string: ${JSON.stringify(accountingDay)}`);
  const [, y, m, d] = match as unknown as [string, string, string, string];
  // UTC noon anchor avoids any DST/midnight edge when subtracting one day.
  const anchor = Date.UTC(Number(y), Number(m) - 1, Number(d), 12, 0, 0);
  const prior = new Date(anchor - 24 * 60 * 60 * 1000);
  const yy = String(prior.getUTCFullYear()).padStart(4, '0');
  const mm = String(prior.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(prior.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
