/**
 * Desktop Notepad vertical slice v0 — mission orchestrator.
 * voice → intent → policy → launch → UIA → OCR fallback → TTS → evidence.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { docsOcr } from '../docs-adapter-client.js';
import { voiceStt, voiceTts } from '../voice-adapter-client.js';
import { redactSecrets } from '../screen-capture.js';
import {
  classifyDesktopIntent,
  evaluateDesktopPolicy,
  normalizeFirstLine,
  linesMateriallyDisagree,
  assertPathInsideEvidenceDir,
  computeEvidenceHash,
  verifyEvidenceIntegrity,
  receiptContainsSecrets,
  sha256Hex,
} from './policy.js';
import {
  launchOwnedNotepad,
  readFirstLineUia,
  captureOwnedWindow,
  closeOwnedNotepad,
  refuseForeignClose,
  assertWindowBelongsToOwnedProcess,
} from './notepad-control.js';
import {
  DESKTOP_SLICE_ID,
  EXPECTED_PROOF_FIRST_LINE,
  type CleanupResult,
  type DesktopEvidencePack,
  type DesktopMissionResult,
  type LineReadResult,
  type ProcessOwnership,
  type TranscriptInput,
} from './types.js';

export type DesktopPorts = {
  stt?: (audioPath: string) => Promise<{ text: string; confidence: number; audioHash: string }>;
  tts?: (text: string, outPath: string) => Promise<{ sha256: string; bytes: number }>;
  ocr?: (imagePath: string) => Promise<{ text: string; engine: string }>;
  launch?: (fixturePath: string) => Promise<ProcessOwnership>;
  readUia?: (ownership: ProcessOwnership) => Promise<{ firstLine: string; treeExcerpt: string } | null>;
  capture?: (ownership: ProcessOwnership, outPng: string) => Promise<{ sha256: string; bytes: number }>;
  close?: (ownership: ProcessOwnership) => Promise<{ closed: boolean; refused: boolean; reason: string }>;
  /** If provided and called → must REJECT (raw coords forbidden). */
  rawCoordinateClick?: (x: number, y: number) => Promise<void>;
};

export type RunDesktopMissionOpts = {
  /** Typed transcript path (no mic). */
  transcript?: TranscriptInput;
  /** Voice WAV path (uses STT). Mutually exclusive with transcript unless both set — transcript wins. */
  audioPath?: string;
  evidenceDir?: string;
  /** Fixture body; default is the live-proof two-line body. */
  fixtureBody?: string;
  /** Force UIA to fail (tests OCR fallback). */
  forceUiaFail?: boolean;
  /** Inject OCR text override for disagreement tests. */
  forceOcrText?: string;
  /** Cross-check OCR even when UIA succeeds. */
  crossCheckOcr?: boolean;
  /** Attempt raw coordinate (must REJECT). */
  attemptRawCoordinates?: boolean;
  /** Attempt close of foreign PID (must refuse). */
  foreignClosePid?: number;
  /** Skip live adapters; use ports only. */
  ports?: DesktopPorts;
  missionId?: string;
  /** Expected first line for VERIFIED (default proof line). */
  expectedFirstLine?: string;
};

const DEFAULT_FIXTURE = `${EXPECTED_PROOF_FIRST_LINE}\nBu sətir yalnız OCR və Unicode yoxlaması üçündür.\n`;

export function defaultDesktopEvidenceDir(missionId: string): string {
  const base =
    process.env.ATLAS_DESKTOP_EVIDENCE_DIR ||
    join(homedir(), '.atlas', 'quarantine', 'evidence');
  return join(base, `desktop-slice-v0-${missionId}`);
}

function defaultStt(audioPath: string) {
  return voiceStt({ filePath: audioPath, sensitive: true }).then((r) => ({
    text: r.text,
    confidence: 0.9,
    audioHash: sha256Hex(readFileSync(audioPath)),
  }));
}

function defaultTts(text: string, outPath: string) {
  return voiceTts({ text, outPath }).then((r) => ({
    sha256: sha256Hex(readFileSync(outPath)),
    bytes: r.bytes,
  }));
}

function defaultOcr(imagePath: string) {
  return docsOcr({ filePath: imagePath, engine: 'fallback' }).then((r) => ({
    text: r.text,
    engine: r.engine,
  }));
}

export async function runDesktopNotepadMission(
  opts: RunDesktopMissionOpts = {},
): Promise<DesktopMissionResult> {
  const missionId = opts.missionId ?? randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const evidenceDir = resolve(opts.evidenceDir ?? defaultDesktopEvidenceDir(missionId));
  mkdirSync(evidenceDir, { recursive: true });

  const ports = opts.ports ?? {};
  const commands: DesktopEvidencePack['commands'] = [];
  const apiCalls: DesktopEvidencePack['apiCalls'] = [];
  let ownership: ProcessOwnership | null = null;
  let fixtureMeta: DesktopEvidencePack['fixture'] = null;
  let lineRead: LineReadResult | null = null;
  let ttsMeta: DesktopEvidencePack['tts'] = null;
  let ttsSucceeded = false;
  let interpreted = null as ReturnType<typeof classifyDesktopIntent>;
  let policy = evaluateDesktopPolicy({
    transcript: { text: '', confidence: 0, audioHash: null, source: 'typed' },
    action: null,
  });
  let transcript: TranscriptInput = opts.transcript ?? {
    text: '',
    confidence: 0,
    audioHash: null,
    source: 'typed',
  };
  let cleanup: CleanupResult = {
    attempted: false,
    closed: false,
    pid: null,
    refused: false,
    reason: 'not_started',
  };
  let rejectReason: string | null = null;
  let spokenText: string | null = null;

  const finish = (status: 'VERIFIED' | 'REJECT', reason: string): DesktopMissionResult => {
    const finishedAt = new Date().toISOString();
    const packBody: Omit<DesktopEvidencePack, 'evidenceHash' | 'verdict'> = {
      missionId,
      sliceId: DESKTOP_SLICE_ID,
      timestamps: { startedAt, finishedAt },
      transcript,
      interpretedAction: interpreted,
      policy,
      fixture: fixtureMeta,
      ownership,
      lineRead,
      tts: ttsMeta,
      commands,
      apiCalls,
      cleanup,
      ttsSucceeded,
    };
    const evidenceHash = computeEvidenceHash(packBody as unknown as Record<string, unknown>);
    // TTS success must never override REJECT
    const finalStatus = status === 'REJECT' ? 'REJECT' : status;
    const evidence: DesktopEvidencePack = {
      ...packBody,
      evidenceHash,
      verdict: { status: finalStatus, reason },
    };
    const evidencePath = join(evidenceDir, 'DESKTOP-RECEIPT.json');
    const json = redactSecrets(JSON.stringify(evidence, null, 2));
    if (receiptContainsSecrets(json)) {
      evidence.verdict = { status: 'REJECT', reason: 'receipt_contains_secret_shape' };
    }
    writeFileSync(evidencePath, json, 'utf8');
    // Immutable copy for tamper demos
    writeFileSync(join(evidenceDir, 'DESKTOP-RECEIPT.sealed.json'), json, 'utf8');
    return {
      status: evidence.verdict.status,
      spokenText,
      evidence,
      evidenceDir,
      evidencePath,
    };
  };

  try {
    if (opts.attemptRawCoordinates) {
      if (ports.rawCoordinateClick) {
        await ports.rawCoordinateClick(0, 0);
      }
      return finish('REJECT', 'raw_coordinates_forbidden_v0');
    }

    // 1–2. Transcript
    if (opts.transcript) {
      transcript = opts.transcript;
    } else if (opts.audioPath) {
      const quarantinedAudio = join(evidenceDir, 'original-voice.wav');
      if (resolve(opts.audioPath) !== resolve(quarantinedAudio)) {
        copyFileSync(opts.audioPath, quarantinedAudio);
      }
      assertPathInsideEvidenceDir(quarantinedAudio, evidenceDir);
      const stt = ports.stt ?? defaultStt;
      try {
        const r = await stt(quarantinedAudio);
        transcript = {
          text: r.text,
          confidence: r.confidence,
          audioHash: r.audioHash,
          source: 'voice',
        };
        apiCalls.push({ id: 'stt', target: 'voice:8765/stt', ok: true, detail: 'ok' });
      } catch (e) {
        apiCalls.push({
          id: 'stt',
          target: 'voice:8765/stt',
          ok: false,
          detail: redactSecrets((e as Error).message || 'stt_failed'),
        });
        return finish('REJECT', `voice_adapter_failure: ${(e as Error).message}`);
      }
    } else {
      return finish('REJECT', 'no_transcript_or_audio');
    }

    // Persist transcript
    writeFileSync(join(evidenceDir, 'transcript.json'), JSON.stringify(transcript, null, 2), 'utf8');

    // 3. Intent + policy (before launch)
    interpreted = classifyDesktopIntent(transcript);
    policy = evaluateDesktopPolicy({ transcript, action: interpreted });
    if (!policy.allow) {
      return finish('REJECT', policy.reason);
    }

    // 4. Fixture under quarantine only
    const fixturePath = join(evidenceDir, `atlas-desktop-proof-${missionId}.txt`);
    const body = opts.fixtureBody ?? DEFAULT_FIXTURE;
    writeFileSync(fixturePath, body, 'utf8');
    const fixtureSha = sha256Hex(readFileSync(fixturePath));
    const expectedFirst = opts.expectedFirstLine ?? normalizeFirstLine(body);
    fixtureMeta = { path: fixturePath, sha256: fixtureSha, firstLineExpected: expectedFirst };
    assertPathInsideEvidenceDir(fixturePath, evidenceDir);

    // 5–6. Launch + bind
    const launch = ports.launch ?? launchOwnedNotepad;
    try {
      ownership = await launch(fixturePath);
      commands.push({
        id: 'launch-notepad',
        command: `notepad ${fixturePath}`,
        exitCode: 0,
        outputHash: sha256Hex(`${ownership.pid}:${ownership.windowHandle}`),
      });
    } catch (e) {
      return finish('REJECT', `launch_failed: ${(e as Error).message}`);
    }
    if (!ownership?.pid) {
      return finish('REJECT', 'launched_pid_unproven');
    }

    // Wrong-window / foreign ownership checks available via title assert
    try {
      assertWindowBelongsToOwnedProcess(ownership, ownership.pid, ownership.windowTitle);
    } catch (e) {
      const close = ports.close ?? closeOwnedNotepad;
      const c = await close(ownership);
      cleanup = {
        attempted: true,
        closed: c.closed,
        pid: ownership.pid,
        refused: c.refused,
        reason: c.reason,
      };
      return finish('REJECT', (e as Error).message);
    }

    const ensureCleanup = async (): Promise<void> => {
      if (!ownership) return;
      if (cleanup.closed && cleanup.pid === ownership.pid) return;
      const close = ports.close ?? closeOwnedNotepad;
      const c = await close(ownership);
      cleanup = {
        attempted: true,
        closed: c.closed,
        pid: ownership.pid,
        refused: c.refused,
        reason: c.reason,
      };
    };
    if (opts.foreignClosePid != null) {
      const ref = refuseForeignClose(ownership, opts.foreignClosePid);
      apiCalls.push({
        id: 'foreign-close-probe',
        target: `pid:${opts.foreignClosePid}`,
        ok: ref.refuse,
        detail: ref.refuse ? ref.reason : 'unexpectedly_allowed',
      });
      if (!ref.refuse) {
        await ensureCleanup();
        return finish('REJECT', 'foreign_close_was_not_refused');
      }
    }

    // 7–9. UIA then OCR fallback / cross-check
    const readUia = ports.readUia ?? readFirstLineUia;
    let uia: { firstLine: string; treeExcerpt: string } | null = null;
    if (!opts.forceUiaFail) {
      try {
        uia = await readUia(ownership);
      } catch {
        uia = null;
      }
    }

    let ocrFirst: string | null = null;
    let ocrEngine: string | null = null;
    let screenshotHash: string | null = null;
    const needOcr = !uia || opts.crossCheckOcr || opts.forceOcrText != null;

    if (needOcr) {
      const shotPath = join(evidenceDir, 'notepad-window.png');
      try {
        const capture = ports.capture ?? captureOwnedWindow;
        const cap = await capture(ownership, shotPath);
        screenshotHash = cap.sha256;
        assertPathInsideEvidenceDir(shotPath, evidenceDir);
        if (opts.forceOcrText != null) {
          ocrFirst = normalizeFirstLine(opts.forceOcrText);
          ocrEngine = 'forced';
        } else {
          const ocr = ports.ocr ?? defaultOcr;
          const o = await ocr(shotPath);
          ocrFirst = normalizeFirstLine(o.text);
          ocrEngine = o.engine;
          apiCalls.push({ id: 'ocr', target: 'docs:8766/ocr', ok: true, detail: o.engine });
        }
      } catch (e) {
        apiCalls.push({
          id: 'ocr',
          target: 'docs:8766/ocr',
          ok: false,
          detail: redactSecrets((e as Error).message || 'ocr_failed'),
        });
        if (!uia) {
          await ensureCleanup();
          return finish('REJECT', `uia_and_ocr_failed: ${(e as Error).message}`);
        }
      }
    }

    if (uia && ocrFirst != null && linesMateriallyDisagree(uia.firstLine, ocrFirst)) {
      lineRead = {
        method: 'uia+ocr_crosscheck',
        firstLine: '',
        uiaFirstLine: normalizeFirstLine(uia.firstLine),
        ocrFirstLine: ocrFirst,
        uiaTreeExcerpt: uia.treeExcerpt,
        screenshotHash,
        ocrEngine,
      };
      await ensureCleanup();
      return finish('REJECT', 'uia_ocr_material_disagreement');
    }

    if (!uia && ocrFirst == null) {
      await ensureCleanup();
      return finish('REJECT', 'first_line_unproven');
    }

    const firstLine = normalizeFirstLine(uia?.firstLine ?? ocrFirst ?? '');
    if (!firstLine) {
      await ensureCleanup();
      return finish('REJECT', 'first_line_empty');
    }

    lineRead = {
      method: uia && ocrFirst != null ? 'uia+ocr_crosscheck' : uia ? 'uia' : 'ocr',
      firstLine,
      uiaFirstLine: uia ? normalizeFirstLine(uia.firstLine) : null,
      ocrFirstLine: ocrFirst,
      uiaTreeExcerpt: uia?.treeExcerpt ?? null,
      screenshotHash,
      ocrEngine,
    };

    if (firstLine !== expectedFirst && linesMateriallyDisagree(firstLine, expectedFirst)) {
      // Allow soft match when expected is proof line and UIA returns it with BOM/space
      if (normalizeFirstLine(firstLine) !== normalizeFirstLine(expectedFirst)) {
        await ensureCleanup();
        return finish('REJECT', `first_line_mismatch: got=${JSON.stringify(firstLine)}`);
      }
    }

    // 10. TTS — Silero v5_4_ru rejects Latin-only; wrap with Cyrillic carrier.
    spokenText = firstLine;
    const ttsSpeak = /[А-Яа-яЁё]/.test(firstLine)
      ? firstLine
      : `Первая строка: ${firstLine}`;
    const ttsPath = join(evidenceDir, 'spoken.wav');
    try {
      const tts = ports.tts ?? defaultTts;
      const t = await tts(ttsSpeak, ttsPath);
      assertPathInsideEvidenceDir(ttsPath, evidenceDir);
      ttsMeta = { path: ttsPath, sha256: t.sha256, text: ttsSpeak };
      ttsSucceeded = true;
      apiCalls.push({ id: 'tts', target: 'voice:8765/tts', ok: true, detail: `bytes=${t.bytes}` });
    } catch (e) {
      apiCalls.push({
        id: 'tts',
        target: 'voice:8765/tts',
        ok: false,
        detail: redactSecrets((e as Error).message || 'tts_failed'),
      });
      // Honest failure — REJECT (do not claim VERIFIED without spoken path for live mission)
      rejectReason = `tts_adapter_failure: ${(e as Error).message}`;
    }

    // 12. Cleanup owned only
    await ensureCleanup();
    if (cleanup.refused) {
      return finish('REJECT', `cleanup_refused: ${cleanup.reason}`);
    }

    if (rejectReason) {
      return finish('REJECT', rejectReason);
    }

    // Integrity self-check
    const interim = finish('VERIFIED', 'notepad_first_line_verified');
    const integrity = verifyEvidenceIntegrity(interim.evidence);
    if (!integrity.ok) {
      interim.evidence.verdict = { status: 'REJECT', reason: integrity.reason };
      writeFileSync(interim.evidencePath, redactSecrets(JSON.stringify(interim.evidence, null, 2)), 'utf8');
      return { ...interim, status: 'REJECT' };
    }
    return interim;
  } catch (e) {
    // Best-effort cleanup on unexpected error
    if (ownership) {
      try {
        const close = ports.close ?? closeOwnedNotepad;
        const c = await close(ownership);
        cleanup = {
          attempted: true,
          closed: c.closed,
          pid: ownership.pid,
          refused: c.refused,
          reason: c.reason,
        };
      } catch {
        /* ignore */
      }
    }
    return finish('REJECT', `mission_error: ${redactSecrets((e as Error).message || 'unknown')}`);
  }
}

/** Demonstrate tamper rejection on a sealed receipt copy. */
export function demonstrateTamperReject(sealedPath: string): {
  originalOk: boolean;
  tamperedRejected: boolean;
  reason: string;
} {
  const raw = readFileSync(sealedPath, 'utf8');
  const pack = JSON.parse(raw) as DesktopEvidencePack;
  const original = verifyEvidenceIntegrity(pack);
  const tampered = { ...pack, lineRead: { ...pack.lineRead!, firstLine: 'TAMPERED' } };
  // Keep old hash → must fail
  const tamperedCheck = verifyEvidenceIntegrity(tampered);
  const outPath = sealedPath.replace(/\.sealed\.json$/, '.tampered.json');
  writeFileSync(outPath, JSON.stringify(tampered, null, 2), 'utf8');
  return {
    originalOk: original.ok,
    tamperedRejected: !tamperedCheck.ok,
    reason: tamperedCheck.reason,
  };
}

export function copyAudioIntoEvidence(srcAudio: string, evidenceDir: string): string {
  mkdirSync(evidenceDir, { recursive: true });
  const dest = join(evidenceDir, 'original-voice.wav');
  copyFileSync(srcAudio, dest);
  assertPathInsideEvidenceDir(dest, evidenceDir);
  return dest;
}

export { verifyEvidenceIntegrity, EXPECTED_PROOF_FIRST_LINE };
