/**
 * HTTP client for local Atlas voice FastAPI adapter (ADR-0010).
 * No brain. Adapter-only.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export type VoiceHealth = {
  ok: boolean;
  service: string;
  version: string;
  role: string;
  brain: boolean;
  scheduler: boolean;
  taskAuthority: boolean;
  engines?: Record<string, unknown>;
  cloudFallbackOrder?: string[];
  sensitiveDefaultLocalOnly?: boolean;
  peakRssMb?: number;
  python?: string;
};

export type VoiceSttResult = {
  text: string;
  engine: string;
  durationMs: number;
  sensitive: boolean;
};

export type VoiceVadResult = {
  speech: boolean;
  speechProbability: number;
  engine: string;
};

export type CloudPolicyResult = {
  allowCloud: boolean;
  reason: string;
  order: string[];
};

const DEFAULT_BASE = process.env.ATLAS_VOICE_URL ?? 'http://127.0.0.1:8765';

export function voiceBaseUrl(override?: string): string {
  return (override ?? DEFAULT_BASE).replace(/\/$/, '');
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`voice-adapter HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

export async function voiceHealth(baseUrl?: string): Promise<VoiceHealth> {
  const res = await fetch(`${voiceBaseUrl(baseUrl)}/health`);
  return parseJson<VoiceHealth>(res);
}

export async function voiceWarmup(
  engines = 'gigaam,vad,tts,whisper',
  baseUrl?: string,
): Promise<Record<string, unknown>> {
  const body = new FormData();
  body.set('engines', engines);
  const res = await fetch(`${voiceBaseUrl(baseUrl)}/warmup`, { method: 'POST', body });
  return parseJson<Record<string, unknown>>(res);
}

export async function voiceStt(opts: {
  filePath: string;
  engine?: 'primary' | 'fallback' | 'auto';
  forcePrimaryFail?: boolean;
  sensitive?: boolean;
  baseUrl?: string;
}): Promise<VoiceSttResult> {
  const buf = readFileSync(opts.filePath);
  const body = new FormData();
  body.set('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  body.set('engine', opts.engine ?? 'auto');
  body.set('force_primary_fail', opts.forcePrimaryFail ? 'true' : 'false');
  body.set('sensitive', opts.sensitive === false ? 'false' : 'true');
  const res = await fetch(`${voiceBaseUrl(opts.baseUrl)}/stt`, { method: 'POST', body });
  return parseJson<VoiceSttResult>(res);
}

export async function voicePtt(opts: {
  filePath: string;
  sensitive?: boolean;
  baseUrl?: string;
}): Promise<VoiceSttResult> {
  const buf = readFileSync(opts.filePath);
  const body = new FormData();
  body.set('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  body.set('sensitive', opts.sensitive === false ? 'false' : 'true');
  const res = await fetch(`${voiceBaseUrl(opts.baseUrl)}/ptt`, { method: 'POST', body });
  return parseJson<VoiceSttResult>(res);
}

export async function voiceVad(opts: {
  filePath: string;
  baseUrl?: string;
}): Promise<VoiceVadResult> {
  const buf = readFileSync(opts.filePath);
  const body = new FormData();
  body.set('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  const res = await fetch(`${voiceBaseUrl(opts.baseUrl)}/vad`, { method: 'POST', body });
  return parseJson<VoiceVadResult>(res);
}

export async function voiceTts(opts: {
  text: string;
  outPath: string;
  speaker?: string;
  voice?: string;
  baseUrl?: string;
}): Promise<{ bytes: number; sampleRate: number; speaker: string; model: string }> {
  const body = new FormData();
  body.set('text', opts.text);
  body.set('speaker', opts.speaker ?? 'v5_4_ru');
  body.set('voice', opts.voice ?? 'xenia');
  const res = await fetch(`${voiceBaseUrl(opts.baseUrl)}/tts`, { method: 'POST', body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`voice-adapter TTS HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  writeFileSync(opts.outPath, buf);
  return {
    bytes: buf.length,
    sampleRate: Number(res.headers.get('x-atlas-tts-sample-rate') ?? '0'),
    speaker: res.headers.get('x-atlas-tts-speaker') ?? 'xenia',
    model: res.headers.get('x-atlas-tts-model') ?? 'v5_4_ru',
  };
}

export async function voiceCloudPolicy(opts: {
  sensitive: boolean;
  baseUrl?: string;
}): Promise<CloudPolicyResult> {
  const res = await fetch(`${voiceBaseUrl(opts.baseUrl)}/cloud-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sensitive: opts.sensitive }),
  });
  return parseJson<CloudPolicyResult>(res);
}
