/**
 * Windows desktop read-only vertical slice v0 — shared types.
 * Notepad-only. Fail-closed. Quarantine evidence only.
 */

export const DESKTOP_SLICE_ID = 'desktop-notepad-v0';
export const MIN_TRANSCRIPT_CONFIDENCE = 0.55;
export const EXPECTED_PROOF_FIRST_LINE = 'Atlas desktop control proof passed.';

export type DesktopVerdictStatus = 'VERIFIED' | 'REJECT';

export type TranscriptInput = {
  text: string;
  confidence: number;
  /** SHA-256 of original audio when voice path used; null for typed transcript. */
  audioHash: string | null;
  source: 'voice' | 'typed';
};

export type InterpretedAction = {
  kind: 'bounded_local_notepad_read_first_line';
  application: 'notepad';
  fixtureMode: 'quarantine_utf8';
};

export type PolicyDecision = {
  allow: boolean;
  reason: string;
  controlHierarchy: readonly [
    'native_api',
    'uia',
    'accessibility',
    'ocr_vision',
    'raw_coordinates_disabled',
  ];
  rawCoordinatesEnabled: false;
};

export type ProcessOwnership = {
  pid: number;
  executablePath: string;
  launchTimestamp: string;
  fixturePath: string;
  windowHandle: string;
  windowTitle: string;
};

export type LineReadResult = {
  method: 'uia' | 'ocr' | 'uia+ocr_crosscheck';
  firstLine: string;
  uiaFirstLine: string | null;
  ocrFirstLine: string | null;
  uiaTreeExcerpt: string | null;
  screenshotHash: string | null;
  ocrEngine: string | null;
};

export type CleanupResult = {
  attempted: boolean;
  closed: boolean;
  pid: number | null;
  refused: boolean;
  reason: string;
};

export type DesktopEvidencePack = {
  missionId: string;
  sliceId: typeof DESKTOP_SLICE_ID;
  timestamps: { startedAt: string; finishedAt: string };
  transcript: TranscriptInput;
  interpretedAction: InterpretedAction | null;
  policy: PolicyDecision;
  fixture: { path: string; sha256: string; firstLineExpected: string } | null;
  ownership: ProcessOwnership | null;
  lineRead: LineReadResult | null;
  tts: { path: string; sha256: string; text: string } | null;
  commands: Array<{ id: string; command: string; exitCode: number; outputHash: string }>;
  apiCalls: Array<{ id: string; target: string; ok: boolean; detail: string }>;
  cleanup: CleanupResult;
  evidenceHash: string;
  verdict: { status: DesktopVerdictStatus; reason: string };
  /** Spoken response must never flip a REJECT. */
  ttsSucceeded: boolean;
};

export type DesktopMissionResult = {
  status: DesktopVerdictStatus;
  spokenText: string | null;
  evidence: DesktopEvidencePack;
  evidenceDir: string;
  evidencePath: string;
};
