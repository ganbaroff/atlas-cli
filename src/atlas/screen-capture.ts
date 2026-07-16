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
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Locate apps/desktop/capture-screen.ps1 across dev/prod/subprocess cwd. */
function resolveCaptureScript(): string | null {
  const override = process.env.ATLAS_CAPTURE_SCRIPT;
  if (override && existsSync(override)) return override;
  const rel = join('apps', 'desktop', 'capture-screen.ps1');
  const cwdCandidate = resolve(process.cwd(), rel);
  if (existsSync(cwdCandidate)) return cwdCandidate;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const c = resolve(dir, rel);
    if (existsSync(c)) return c;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Capture the primary display. Returns the artifact paths + dimensions.
 * Throws only on a hard failure (no PowerShell, capture script missing).
 */
export function captureScreen(opts: { outDir?: string; withThumb?: boolean } = {}): Promise<CaptureResult> {
  const dir = opts.outDir || defaultCaptureDir();
  const script = resolveCaptureScript();
  if (!script) return Promise.reject(new Error('capture-screen.ps1 not found (fail-closed)'));
  mkdirSync(dir, { recursive: true });
  const base = `screen-${stamp()}`;
  const pngPath = join(dir, `${base}.png`);
  const thumbPath = opts.withThumb === false ? '' : join(dir, `${base}.thumb.jpg`);

  return new Promise((finish, fail) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script],
      {
        env: { ...process.env, ATLAS_CAP_OUT: pngPath, ATLAS_CAP_THUMB: thumbPath },
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
      if (code !== 0 || !existsSync(pngPath)) {
        fail(new Error(`capture failed (exit ${code}): ${Buffer.concat(err).toString().slice(0, 200)}`));
        return;
      }
      let width = 0;
      let height = 0;
      try {
        const meta = JSON.parse(Buffer.concat(out).toString().trim());
        width = meta.width ?? 0;
        height = meta.height ?? 0;
      } catch {
        /* dimensions best-effort */
      }
      finish({
        path: pngPath,
        thumbPath: thumbPath && existsSync(thumbPath) ? thumbPath : null,
        width,
        height,
        bytes: statSync(pngPath).size,
        ts: new Date().toISOString(),
      });
    });
  });
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
