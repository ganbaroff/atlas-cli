/**
 * ADR-0010: wire Telegram voice/photo to local adapters (no second brain).
 *
 * STT ladder (non-sensitive only):
 *   Groq → Google Cloud → Gemini → local → OpenAI LAST
 * Sensitive CEO audio: LOCAL ONLY — cloud is hard-refused (not an env flag).
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TranscribeResult = {
  text: string;
  engine: string;
  local: boolean;
};

export type OcrResult = {
  text: string;
  engine: string;
};

/** Free-first cloud STT order before paid OpenAI. Local is attempted separately. */
export const FREE_STT_LADDER = ['groq', 'google-cloud', 'gemini'] as const;
export type FreeSttEngine = (typeof FREE_STT_LADDER)[number];

/** Prefer local adapter when available (non-sensitive path). */
export function voicePreferLocal(): boolean {
  return process.env.ATLAS_VOICE_PREFER_LOCAL !== '0';
}

export function docsPreferLocal(): boolean {
  return process.env.ATLAS_DOCS_PREFER_LOCAL !== '0';
}

/**
 * Sensitive audio must never leave the machine.
 * Not overridable by ATLAS_VOICE_PREFER_LOCAL=0.
 */
export function sensitiveAudioAllowsCloud(sensitive: boolean): boolean {
  return sensitive !== true;
}

async function tryLocalStt(audio: Buffer, ext: string): Promise<TranscribeResult | null> {
  try {
    const { voiceHealth, voiceStt } = await import('./voice-adapter-client.js');
    await voiceHealth();
    const tmp = join(tmpdir(), `atlas-voice-${Date.now()}.${ext}`);
    writeFileSync(tmp, audio);
    try {
      const out = await voiceStt({ filePath: tmp, sensitive: true });
      const text = (out.text ?? '').trim();
      if (text) return { text, engine: out.engine, local: true };
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
    }
  } catch (err) {
    console.warn(
      '[telegram-capability] local STT failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

async function confirmCloudPolicyAllows(sensitive: boolean): Promise<{
  allow: boolean;
  reason: string;
  order: string[];
}> {
  try {
    const { voiceCloudPolicy } = await import('./voice-adapter-client.js');
    const policy = await voiceCloudPolicy({ sensitive });
    return {
      allow: policy.allowCloud && sensitiveAudioAllowsCloud(sensitive),
      reason: policy.reason,
      order: policy.order ?? [],
    };
  } catch {
    // Adapter down: still enforce local TS guard
    return {
      allow: sensitiveAudioAllowsCloud(sensitive),
      reason: sensitive
        ? 'sensitive audio stays local-only (client-enforced; adapter unreachable)'
        : 'adapter unreachable; client may try free cloud ladder',
      order: [...FREE_STT_LADDER],
    };
  }
}

async function whisperCompatibleStt(opts: {
  url: string;
  apiKey: string;
  audio: Buffer;
  ext: string;
  engine: string;
  model: string;
}): Promise<TranscribeResult | null> {
  const tmp = join(tmpdir(), `voice_${opts.engine}_${Date.now()}.${opts.ext}`);
  try {
    writeFileSync(tmp, opts.audio);
    const form = new FormData();
    form.append(
      'file',
      new Blob([readFileSync(tmp)], { type: `audio/${opts.ext}` }),
      `voice.${opts.ext}`,
    );
    form.append('model', opts.model);
    const wr = await fetch(opts.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
    });
    if (!wr.ok) return null;
    const data = (await wr.json()) as { text?: string };
    const text = data.text?.trim();
    if (!text) return null;
    return { text, engine: opts.engine, local: false };
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* */
    }
  }
}

/** Groq free-tier Whisper-compatible STT. */
async function sttGroq(audio: Buffer, ext: string): Promise<TranscribeResult | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  return whisperCompatibleStt({
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    apiKey,
    audio,
    ext,
    engine: 'groq-whisper',
    model: process.env.ATLAS_GROQ_STT_MODEL ?? 'whisper-large-v3',
  });
}

/**
 * Google Cloud Speech-to-Text (v1 recognize) — requires GOOGLE_STT_ACCESS_TOKEN
 * or GOOGLE_API_KEY with Speech API enabled. Skips honestly when unset.
 */
async function sttGoogleCloud(audio: Buffer, _ext: string): Promise<TranscribeResult | null> {
  const token = process.env.GOOGLE_STT_ACCESS_TOKEN;
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!token && !apiKey) return null;
  try {
    const body = {
      config: {
        languageCode: process.env.ATLAS_STT_LANG ?? 'ru-RU',
        enableAutomaticPunctuation: true,
        model: 'default',
      },
      audio: { content: audio.toString('base64') },
    };
    const url = token
      ? 'https://speech.googleapis.com/v1/speech:recognize'
      : `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const wr = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!wr.ok) return null;
    const data = (await wr.json()) as {
      results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
    const text = data.results?.[0]?.alternatives?.[0]?.transcript?.trim();
    if (!text) return null;
    return { text, engine: 'google-cloud-stt', local: false };
  } catch {
    return null;
  }
}

/** Gemini multimodal STT via generateContent (free-tier when key is GenAI). */
async function sttGemini(audio: Buffer, ext: string): Promise<TranscribeResult | null> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const model = process.env.ATLAS_GEMINI_STT_MODEL ?? 'gemini-2.0-flash';
  const mime =
    ext === 'ogg' || ext === 'oga'
      ? 'audio/ogg'
      : ext === 'mp3'
        ? 'audio/mpeg'
        : ext === 'wav'
          ? 'audio/wav'
          : `audio/${ext}`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const wr = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: 'Transcribe this audio to plain text only. No commentary.' },
              { inline_data: { mime_type: mime, data: audio.toString('base64') } },
            ],
          },
        ],
      }),
    });
    if (!wr.ok) return null;
    const data = (await wr.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
    if (!text) return null;
    return { text, engine: `gemini-stt:${model}`, local: false };
  } catch {
    return null;
  }
}

async function sttOpenAiLast(audio: Buffer, ext: string): Promise<TranscribeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      text: '[voice unavailable — free STT exhausted and no OpenAI key]',
      engine: 'none',
      local: false,
    };
  }
  const hit = await whisperCompatibleStt({
    url: 'https://api.openai.com/v1/audio/transcriptions',
    apiKey,
    audio,
    ext,
    engine: 'openai-whisper-1',
    model: 'whisper-1',
  });
  if (hit) return hit;
  return {
    text: '[voice error: OpenAI Whisper failed — key may be expired]',
    engine: 'openai-whisper-1',
    local: false,
  };
}

/**
 * Non-sensitive cloud ladder: Groq → Google Cloud → Gemini → OpenAI LAST.
 * Local is tried by the caller before/after per prefer-local policy.
 */
export async function transcribeVoiceCloudLadder(
  audio: Buffer,
  ext: string,
): Promise<TranscribeResult> {
  const steps: Array<() => Promise<TranscribeResult | null>> = [
    () => sttGroq(audio, ext),
    () => sttGoogleCloud(audio, ext),
    () => sttGemini(audio, ext),
  ];
  for (const step of steps) {
    const hit = await step();
    if (hit?.text) return hit;
  }
  return sttOpenAiLast(audio, ext);
}

export async function transcribeVoiceBytes(
  audio: Buffer,
  ext = 'ogg',
  opts: { sensitive?: boolean } = {},
): Promise<TranscribeResult> {
  const sensitive = opts.sensitive !== false; // Telegram voice defaults sensitive

  // Sensitive: local only. Env cannot open the cloud door.
  if (sensitive) {
    const local = await tryLocalStt(audio, ext);
    if (local) return local;
    const policy = await confirmCloudPolicyAllows(true);
    if (!policy.allow) {
      return {
        text: `[voice unavailable — sensitive audio local-only (${policy.reason})]`,
        engine: 'none',
        local: false,
      };
    }
    // Defense in depth — even if policy misfires, refuse cloud for sensitive.
    return {
      text: '[voice unavailable — sensitive audio local-only; cloud hard-refused]',
      engine: 'none',
      local: false,
    };
  }

  // Non-sensitive: optional local first, then free ladder, OpenAI last.
  if (voicePreferLocal()) {
    const local = await tryLocalStt(audio, ext);
    if (local) return local;
  }

  const policy = await confirmCloudPolicyAllows(false);
  if (!policy.allow) {
    // Retry local once more before giving up
    const local = await tryLocalStt(audio, ext);
    if (local) return local;
    return {
      text: `[voice unavailable — cloud denied: ${policy.reason}]`,
      engine: 'none',
      local: false,
    };
  }

  const cloud = await transcribeVoiceCloudLadder(audio, ext);
  if (cloud.engine !== 'none' && cloud.text && !cloud.text.startsWith('[voice')) {
    return cloud;
  }

  // Ladder ended on OpenAI miss — try local as last free resort before returning error
  const localLast = await tryLocalStt(audio, ext);
  if (localLast) return localLast;
  return cloud;
}

export async function transcribeVoiceUrl(
  url: string,
  opts: { sensitive?: boolean } = {},
): Promise<TranscribeResult> {
  const res = await fetch(url);
  if (!res.ok) {
    return {
      text: `[voice error: download ${res.status}]`,
      engine: 'none',
      local: false,
    };
  }
  return transcribeVoiceBytes(Buffer.from(await res.arrayBuffer()), 'ogg', opts);
}

export async function ocrImageBytes(image: Buffer, filename = 'photo.jpg'): Promise<OcrResult | null> {
  if (!docsPreferLocal()) return null;
  const tmp = join(tmpdir(), `atlas-ocr-${Date.now()}-${filename}`);
  try {
    const { docsHealth, docsOcr } = await import('./docs-adapter-client.js');
    await docsHealth();
    writeFileSync(tmp, image);
    const out = await docsOcr({ filePath: tmp, engine: 'auto' });
    const text = (out.text ?? '').trim();
    if (!text) return null;
    return { text, engine: out.engine };
  } catch (err) {
    console.warn(
      '[telegram-capability] local OCR failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* */
    }
  }
}
