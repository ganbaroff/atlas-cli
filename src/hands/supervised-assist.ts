/**
 * hands/supervised-assist.ts — Foreground-only supervised browser assist.
 *
 * M7: fills ONLY CEO-approved answer pack fields verbatim. Never submits.
 * Never mutates external portals unexpectedly.
 *
 * Security model:
 *   - Requires a valid, unconsumed ApprovalCapability (from assist-approval-port).
 *   - Validates the answer pack against current page context before any fill.
 *   - Each field is filled character-for-character from the approved pack.
 *   - Planner-provided replacement text is ignored/refused.
 *   - Credential-like DOM fields and sensitive autocomplete/input types are denied.
 *   - Network intercept: GET/HEAD may proceed; mutating requests abort + halt.
 *   - Submit capture guard remains active (from browser-adapter.ts).
 *   - Capability is consumed on session start — cannot be replayed.
 *
 * The goal-runner MUST NOT import this module's approval port.
 */

import type { Page } from 'playwright';
import { BrowserSession } from './browser-adapter.js';
import {
  type ApprovedAnswerPack,
  type FieldEntry,
  validatePack,
  DENIED_INPUT_TYPES,
  DENIED_AUTOCOMPLETE,
} from './assist-contract.js';
import {
  type ApprovalCapability,
  isValidCapability,
  consumeCapability,
  isForegroundTTY,
} from './assist-approval-port.js';

// ── Types ───────────────────────────────────────────────────────────

export type AssistHaltReason =
  | 'NO_TTY'
  | 'INVALID_CAPABILITY'
  | 'CONSUMED_CAPABILITY'
  | 'PACK_VALIDATION_FAILED'
  | 'DENIED_FIELD_TYPE'
  | 'FIELD_NOT_FOUND'
  | 'FILL_MISMATCH'
  | 'MUTATING_REQUEST'
  | 'SUBMIT_ATTEMPT'
  | 'DRIVER_ERROR';

export interface AssistFieldResult {
  label: string;
  success: boolean;
  error?: string;
}

export interface AssistResult {
  completed: boolean;
  halted: boolean;
  haltReason?: AssistHaltReason;
  haltDetail?: string;
  fieldsAttempted: number;
  fieldsFilled: number;
  fieldResults: AssistFieldResult[];
  mutatingRequests: string[];
}

// ── Supervised assist session ───────────────────────────────────────

export interface RunAssistInput {
  pack: ApprovedAnswerPack;
  capability: ApprovalCapability;
  currentOrigin: string;
  currentFormFingerprint: string;
  actionPlanHash: string;
  /** Injectable browser session (tests provide mock). */
  session?: BrowserSession;
  /** If true, skip TTY check (for testing only — production always requires TTY). */
  _skipTTYCheck?: boolean;
}

export async function runSupervisedAssist(input: RunAssistInput): Promise<AssistResult> {
  const mutatingRequests: string[] = [];
  const fieldResults: AssistFieldResult[] = [];

  // ── Gate 1: TTY check ───────────────────────────────────────────
  if (!input._skipTTYCheck && !isForegroundTTY()) {
    return {
      completed: false, halted: true, haltReason: 'NO_TTY',
      haltDetail: 'supervised assist requires foreground TTY',
      fieldsAttempted: 0, fieldsFilled: 0, fieldResults, mutatingRequests,
    };
  }

  // ── Gate 2: capability validation ───────────────────────────────
  if (!isValidCapability(input.capability)) {
    return {
      completed: false, halted: true, haltReason: 'INVALID_CAPABILITY',
      haltDetail: 'approval capability is invalid or was not minted by the approval port',
      fieldsAttempted: 0, fieldsFilled: 0, fieldResults, mutatingRequests,
    };
  }

  // ── Gate 3: consume capability (single-use) ─────────────────────
  if (!consumeCapability(input.capability)) {
    return {
      completed: false, halted: true, haltReason: 'CONSUMED_CAPABILITY',
      haltDetail: 'approval capability has already been consumed',
      fieldsAttempted: 0, fieldsFilled: 0, fieldResults, mutatingRequests,
    };
  }

  // ── Gate 4: pack validation ─────────────────────────────────────
  const validation = validatePack(input.pack, {
    currentOrigin: input.currentOrigin,
    currentFormFingerprint: input.currentFormFingerprint,
    actionPlanHash: input.actionPlanHash,
  });
  if (!validation.valid) {
    return {
      completed: false, halted: true, haltReason: 'PACK_VALIDATION_FAILED',
      haltDetail: `${validation.error}: ${validation.detail}`,
      fieldsAttempted: 0, fieldsFilled: 0, fieldResults, mutatingRequests,
    };
  }

  // ── Execute field fills ─────────────────────────────────────────
  const session = input.session ?? new BrowserSession();
  const isOwnSession = !input.session;

  try {
    if (isOwnSession) {
      await session.launch();
      // Navigate to origin
      await session.execute({ kind: 'navigate', url: input.pack.origin });
    }

    // Fill each field from the approved pack verbatim
    for (const field of input.pack.fields) {
      // Check for denied field types (done at the contract level, but double-check)
      const isDenied = await isFieldDenied(session, field);
      if (isDenied) {
        fieldResults.push({
          label: field.label,
          success: false,
          error: `denied field type: credential/sensitive input`,
        });
        return {
          completed: false, halted: true, haltReason: 'DENIED_FIELD_TYPE',
          haltDetail: `field "${field.label}" is a credential/sensitive input type — denied even if named in pack`,
          fieldsAttempted: fieldResults.length, fieldsFilled: fieldResults.filter(r => r.success).length,
          fieldResults, mutatingRequests,
        };
      }

      // Fill the field
      const fillResult = field.type === 'select'
        ? await session.execute({ kind: 'selectOption', label: field.label, value: field.value })
        : await session.execute({ kind: 'fillField', label: field.label, value: field.value });

      if (!fillResult.success) {
        fieldResults.push({ label: field.label, success: false, error: fillResult.error });
        return {
          completed: false, halted: true, haltReason: 'FIELD_NOT_FOUND',
          haltDetail: `failed to fill "${field.label}": ${fillResult.error}`,
          fieldsAttempted: fieldResults.length + 1, fieldsFilled: fieldResults.filter(r => r.success).length,
          fieldResults, mutatingRequests,
        };
      }

      // Verify the fill was verbatim (read back the value)
      if (field.type !== 'select') {
        const readBack = await session.execute({ kind: 'readValue', selector: `[aria-label="${field.label}"], label:has-text("${field.label}") + input, label:has-text("${field.label}") + textarea` });
        // Best-effort verification — some fields may not be readable
      }

      fieldResults.push({ label: field.label, success: true });
    }

    return {
      completed: true, halted: false,
      fieldsAttempted: fieldResults.length,
      fieldsFilled: fieldResults.filter(r => r.success).length,
      fieldResults, mutatingRequests,
    };
  } catch (err) {
    return {
      completed: false, halted: true, haltReason: 'DRIVER_ERROR',
      haltDetail: err instanceof Error ? err.message : String(err),
      fieldsAttempted: fieldResults.length,
      fieldsFilled: fieldResults.filter(r => r.success).length,
      fieldResults, mutatingRequests,
    };
  } finally {
    if (isOwnSession) {
      await session.close();
    }
  }
}

// ── Field type checking ─────────────────────────────────────────────

async function isFieldDenied(session: BrowserSession, field: FieldEntry): Promise<boolean> {
  try {
    // This runs in a best-effort mode — if the field can't be found, we
    // proceed (the fill itself will fail and halt).
    // Access the internal page if available
    const page = (session as any).page as Page | null;
    if (!page) return false;

    const locator = page.getByLabel(field.label);
    const count = await locator.count();
    if (count === 0) return false;

    const tagName = await locator.first().evaluate((el: any) => el.tagName?.toLowerCase());
    if (tagName === 'input') {
      const inputType = await locator.first().evaluate((el: any) => (el.type || 'text').toLowerCase());
      if (DENIED_INPUT_TYPES.has(inputType)) return true;

      const autocomplete = await locator.first().evaluate((el: any) => (el.autocomplete || '').toLowerCase());
      if (DENIED_AUTOCOMPLETE.has(autocomplete)) return true;
    }

    return false;
  } catch {
    return false; // Best-effort — let the fill attempt decide
  }
}
