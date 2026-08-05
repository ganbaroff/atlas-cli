/**
 * Desktop slice v0 — policy, intent, evidence helpers (pure / fail-closed).
 */
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import {
  MIN_TRANSCRIPT_CONFIDENCE,
  type InterpretedAction,
  type PolicyDecision,
  type TranscriptInput,
} from './types.js';

export const CONTROL_HIERARCHY = [
  'native_api',
  'uia',
  'accessibility',
  'ocr_vision',
  'raw_coordinates_disabled',
] as const;

const NOTEPAD_CMD_RE =
  /открой\s+тестов(ый|ого)?\s+файл.*блокнот|блокнот.*прочитай\s+перв|прочитай\s+первую\s+строк/i;

export function classifyDesktopIntent(transcript: TranscriptInput): InterpretedAction | null {
  const text = (transcript.text || '').trim();
  if (!text) return null;
  if (!NOTEPAD_CMD_RE.test(text) && !/notepad|блокнот/i.test(text)) return null;
  // Require both open/read signals for this bounded mission
  const wantsOpen = /открой|open|откройте/i.test(text);
  const wantsRead = /прочитай|прочти|read|перв/i.test(text);
  const wantsNotepad = /блокнот|notepad/i.test(text);
  if (!(wantsOpen && wantsRead && wantsNotepad)) return null;
  return {
    kind: 'bounded_local_notepad_read_first_line',
    application: 'notepad',
    fixtureMode: 'quarantine_utf8',
  };
}

export function evaluateDesktopPolicy(opts: {
  transcript: TranscriptInput;
  action: InterpretedAction | null;
  allowRawCoordinates?: boolean;
}): PolicyDecision {
  const base: PolicyDecision = {
    allow: false,
    reason: 'init',
    controlHierarchy: CONTROL_HIERARCHY,
    rawCoordinatesEnabled: false,
  };
  if (opts.allowRawCoordinates === true) {
    return { ...base, allow: false, reason: 'raw_coordinates_forbidden_v0' };
  }
  if (opts.transcript.confidence < MIN_TRANSCRIPT_CONFIDENCE) {
    return { ...base, allow: false, reason: 'transcript_confidence_below_threshold' };
  }
  if (!opts.action) {
    return { ...base, allow: false, reason: 'intent_ambiguous_or_unsupported' };
  }
  if (opts.action.kind !== 'bounded_local_notepad_read_first_line') {
    return { ...base, allow: false, reason: 'action_outside_notepad_v0_scope' };
  }
  return {
    allow: true,
    reason: 'bounded_notepad_read_allowed',
    controlHierarchy: CONTROL_HIERARCHY,
    rawCoordinatesEnabled: false,
  };
}

export {
  MIN_TRANSCRIPT_CONFIDENCE,
} from './types.js';

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function normalizeFirstLine(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')[0]
    ?.replace(/\u200b/g, '')
    .trim() ?? '';
}

/** Material disagreement: normalized strings differ after whitespace collapse. */
export function linesMateriallyDisagree(a: string, b: string): boolean {
  const na = normalizeFirstLine(a).replace(/\s+/g, ' ').toLowerCase();
  const nb = normalizeFirstLine(b).replace(/\s+/g, ' ').toLowerCase();
  if (!na || !nb) return true;
  return na !== nb;
}

export function assertPathInsideEvidenceDir(filePath: string, evidenceDir: string): void {
  const root = resolve(evidenceDir) + sep;
  const target = resolve(filePath);
  if (!(target + sep).startsWith(root) && target !== resolve(evidenceDir)) {
    throw new Error(`path_escapes_evidence_dir: ${filePath}`);
  }
}

export function receiptContainsSecrets(jsonText: string): boolean {
  const patterns = [
    /\bsk-[A-Za-z0-9]{16,}\b/,
    /\bAIza[0-9A-Za-z\-_]{20,}\b/,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}/,
    /\bBearer\s+[A-Za-z0-9._\-]{16,}/i,
  ];
  return patterns.some((re) => re.test(jsonText));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function computeEvidenceHash(payload: Record<string, unknown>): string {
  const { verdict: _v, evidenceHash: _h, ...rest } = payload as {
    verdict?: unknown;
    evidenceHash?: unknown;
  } & Record<string, unknown>;
  return sha256Hex(stableStringify(rest));
}

export function verifyEvidenceIntegrity(pack: {
  evidenceHash: string;
  [k: string]: unknown;
}): { ok: boolean; reason: string } {
  const recomputed = computeEvidenceHash(pack);
  if (recomputed !== pack.evidenceHash) {
    return { ok: false, reason: 'evidence_hash_mismatch' };
  }
  return { ok: true, reason: 'evidence_hash_ok' };
}
