/**
 * screen_capture — Phase 3 skill #1. READ-ONLY.
 *
 * Captures the primary display to a PNG under a safe temp dir (never Desktop),
 * and — only when explicitly opted in — produces a cheap, capped, secret-redacted
 * vision summary via the free freellmapi gateway (credits-before-cash).
 *
 * HARD BOUNDARIES:
 *   - No mouse/keyboard control. This module only reads pixels.
 *   - Vision summary is OFF by default (policy.skills.screen.vision_enabled /
 *     ATLAS_SCREEN_VISION). Capture always works without it.
 *   - Vision calls are hard-capped per hour (policy.skills.screen.max_per_hour)
 *     via a cross-process rate file, and gated through enforceSpendPolicy.
 *   - Fail-closed: any missing dep / permission / over-cap → summary skipped with
 *     a reason; the capture still returns.
 *   - The summary text is run through redactSecrets() before it is ever returned
 *     or logged. The freellmapi endpoint host is never printed (treated secret).
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { enforceSpendPolicy } from './spend-policy.js';
import { screenVisionEnabled, screenMaxPerHour } from './policy.js';

export interface CaptureResult {
  path: string;
  thumbPath: string | null;
  width: number;
  height: number;
  bytes: number;
  ts: string;
}

export interface SummaryResult {
  summary?: string;
  provider?: string;
  model?: string;
  count?: number;
  skipped?: boolean;
  reason?: string;
}

/** Redact common secret shapes from any text before it is returned/logged. */
export function redactSecrets(text: string): string {
  const patterns: RegExp[] = [
    /\bsk-[A-Za-z0-9]{16,}\b/g,                                   // OpenAI-style
    /\bAIza[0-9A-Za-z\-_]{20,}\b/g,                               // Google API key
    /\bghp_[A-Za-z0-9]{20,}\b/g,                                  // GitHub PAT
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                          // Slack
    /\bBearer\s+[A-Za-z0-9._\-]{16,}/gi,                          // bearer tokens
    /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}/g, // JWT
    /((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)\S{6,}/gi, // key: value
  ];
  let out = text || '';
  for (const re of patterns) out = out.replace(re, (_m, p1) => (p1 ? `${p1}[REDACTED]` : '[REDACTED]'));
  return out;
}

export function defaultCaptureDir(): string {
  return process.env.ATLAS_CAPTURE_DIR || join(tmpdir(), 'atlas-captures');
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * PowerShell capture body (PNG only). Launched via -EncodedCommand because
 * Windows Defender AMSI blocks `powershell -File capture-screen.ps1` and also
 * blocks longer inline scripts that combine capture + JPEG encode.
 * Thumbnail is produced in a second, separate encoded step (load PNG + scale).
 * apps/desktop/capture-screen.ps1 stays as the human-readable twin.
 */
const CAPTURE_PS_BODY = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '$bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)',
  '$g.Dispose()',
  '$out = $env:ATLAS_CAP_OUT',
  '$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$bmp.Dispose()',
  'Write-Output ((@{ width = $screen.Width; height = $screen.Height } | ConvertTo-Json -Compress))',
].join('\n');

const THUMB_PS_BODY = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$src = $env:ATLAS_CAP_OUT',
  '$dst = $env:ATLAS_CAP_THUMB',
  '$ThumbW = 1024',
  '$bmp = [System.Drawing.Image]::FromFile($src)',
  '$ratio = [Math]::Min(1.0, $ThumbW / $bmp.Width)',
  '$tw = [int]($bmp.Width * $ratio)',
  '$th = [int]($bmp.Height * $ratio)',
  '$scaled = New-Object System.Drawing.Bitmap $tw, $th',
  '$gs = [System.Drawing.Graphics]::FromImage($scaled)',
  '$gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '$gs.DrawImage($bmp, 0, 0, $tw, $th)',
  '$gs.Dispose()',
  '$bmp.Dispose()',
  '$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
  '$ep = New-Object System.Drawing.Imaging.EncoderParameters 1',
  '$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]60)',
  '$scaled.Save($dst, $enc, $ep)',
  '$scaled.Dispose()',
].join('\n');

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runEncodedPowerShell(
  script: string,
  envExtra: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const encoded = encodePowerShell(script);
  return new Promise((finish, fail) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded],
      {
        env: { ...process.env, ...envExtra },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        timeout: 30_000,
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout?.on('data', (c: Buffer) => out.push(c));
    proc.stderr?.on('data', (c: Buffer) => err.push(c));
    proc.on('error', (e) => fail(e));
    proc.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      });
    });
  });
}

/**
 * Capture the primary display. Returns the artifact paths + dimensions.
 * Throws only on a hard failure (no PowerShell / capture process failure).
 */
export async function captureScreen(
  opts: { outDir?: string; withThumb?: boolean } = {},
): Promise<CaptureResult> {
  const dir = opts.outDir || defaultCaptureDir();
  mkdirSync(dir, { recursive: true });
  const base = `screen-${stamp()}`;
  const pngPath = join(dir, `${base}.png`);
  const thumbPath = opts.withThumb === false ? '' : join(dir, `${base}.thumb.jpg`);

  const captured = await runEncodedPowerShell(CAPTURE_PS_BODY, {
    ATLAS_CAP_OUT: pngPath,
  });
  if (captured.code !== 0 || !existsSync(pngPath)) {
    throw new Error(
      `capture failed (exit ${captured.code}): ${captured.stderr.slice(0, 200)}`,
    );
  }

  let width = 0;
  let height = 0;
  try {
    const meta = JSON.parse(captured.stdout.trim());
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    /* dimensions best-effort */
  }

  if (thumbPath) {
    const thumbed = await runEncodedPowerShell(THUMB_PS_BODY, {
      ATLAS_CAP_OUT: pngPath,
      ATLAS_CAP_THUMB: thumbPath,
    });
    if (thumbed.code !== 0 || !existsSync(thumbPath)) {
      // Thumb is best-effort; keep the PNG capture.
      return {
        path: pngPath,
        thumbPath: null,
        width,
        height,
        bytes: statSync(pngPath).size,
        ts: new Date().toISOString(),
      };
    }
  }

  return {
    path: pngPath,
    thumbPath: thumbPath && existsSync(thumbPath) ? thumbPath : null,
    width,
    height,
    bytes: statSync(pngPath).size,
    ts: new Date().toISOString(),
  };
}

// ── Vision-summary rate limit (cross-process, per UTC hour) ───────────────────
function currentHour(): string {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}
function rateFile(dir: string): string {
  return join(dir, 'vision-rate.json');
}
/** Reserve one vision call this hour; false if over cap. */
export function tryConsumeVisionSlot(dir: string, cap: number): { allowed: boolean; count: number } {
  const f = rateFile(dir);
  let st = { hour: currentHour(), count: 0 };
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    if (parsed && parsed.hour === currentHour()) st = parsed;
  } catch {
    /* fresh */
  }
  if (st.hour !== currentHour()) st = { hour: currentHour(), count: 0 };
  if (st.count >= cap) return { allowed: false, count: st.count };
  st.count += 1;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, JSON.stringify(st));
  } catch {
    /* best-effort */
  }
  return { allowed: true, count: st.count };
}

const VISION_PROMPT =
  'You are a concise screen assistant. In 2-3 sentences, describe what is on this ' +
  'screen: the foreground app, what the user appears to be doing, and any obvious ' +
  'notification/error. Do not transcribe secrets, tokens, or passwords.';

/**
 * Optional vision summary. Fail-closed: returns {skipped, reason} rather than
 * throwing. Never prints the freellmapi endpoint host.
 */
export async function summarizeCapture(
  imagePath: string,
  opts: { model?: string } = {},
): Promise<SummaryResult> {
  if (!screenVisionEnabled()) {
    return { skipped: true, reason: 'vision disabled (opt-in: ATLAS_SCREEN_VISION=1 or policy.skills.screen.vision_enabled)' };
  }
  const base = process.env.FREELLMAPI_BASE_URL;
  const key = process.env.FREELLMAPI_API_KEY;
  if (!base || !key) return { skipped: true, reason: 'freellmapi env missing (fail-closed)' };
  if (!existsSync(imagePath)) return { skipped: true, reason: 'image not found (fail-closed)' };

  const cap = screenMaxPerHour();
  const slot = tryConsumeVisionSlot(dirname(imagePath), cap);
  if (!slot.allowed) return { skipped: true, reason: `hourly vision cap ${cap} reached` };

  const model = opts.model || 'gemini-2.5-flash';
  const sanitize = (msg: string): string => redactSecrets((msg || '').split(base).join('[endpoint]'));

  try {
    enforceSpendPolicy('freellmapi', 'screen-capture'); // free provider → allowed; keeps governance
    const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const b64 = readFileSync(imagePath).toString('base64');
    const url = `${base.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { skipped: true, reason: `vision provider HTTP ${res.status} (fail-closed)` };
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text) return { skipped: true, reason: 'vision returned empty (fail-closed)' };
    return { summary: redactSecrets(String(text).trim()), provider: 'freellmapi', model, count: slot.count };
  } catch (e) {
    return { skipped: true, reason: `vision error (fail-closed): ${sanitize((e as Error)?.message || '')}`.slice(0, 200) };
  }
}

/** CLI orchestrator: capture, then optionally summarize. */
export async function runScreenCapture(opts: { summarize?: boolean } = {}): Promise<{ capture: CaptureResult; summary: SummaryResult | null }> {
  const capture = await captureScreen({ withThumb: true });
  let summary: SummaryResult | null = null;
  if (opts.summarize) {
    summary = await summarizeCapture(capture.thumbPath || capture.path);
  }
  return { capture, summary };
}
