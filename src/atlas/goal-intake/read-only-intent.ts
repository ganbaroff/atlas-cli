/**
 * Shared deterministic read-only intent detector.
 * Used by Goal Intake and Context Assembly — no second subsystem.
 */
export const READ_ONLY_CEO_INTENT_RE =
  /ничего не меняй|не меняй|read[\s-]?only|не трогай|audit|анализ|analyze|inspect|review|observe|без изменен/i;

/** True when CEO message forbids mutations / asks for observe-only work. */
export function isReadOnlyCeoIntent(message: string): boolean {
  return READ_ONLY_CEO_INTENT_RE.test(message ?? '');
}
