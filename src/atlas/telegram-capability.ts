/**
 * ADR-0010: wire Telegram voice/photo to local adapters (no second brain).
 * Local-first for sensitive audio; OpenAI Whisper remains cloud fallback.
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

/** Sensitive CEO audio stays local unless explicitly disabled. */
export function voicePreferLocal(): boolean {
  return process.env.ATLAS_VOICE_PREFER_LOCAL !== '0';
}

export function docsPreferLocal(): boolean {
  return process.env.ATLAS_DOCS_PREFER_LOCAL !== '0';
}

export async function transcribeVoiceBytes(
  audio: Buffer,
  ext = 'ogg',
): Promise<TranscribeResult> {
  if (voicePreferLocal()) {
    try {
      const { voiceHealth, voiceStt } = await import('./voice-adapter-client.js');
      await voiceHealth();
      const tmp = join(tmpdir(), `atlas-voice-${Date.now()}.${ext}`);
      writeFileSync(tmp, audio);
      try {
        const out = await voiceStt({ filePath: tmp, sensitive: true });
        const text = (out.text ?? '').trim();
        if (text) {
          return { text, engine: out.engine, local: true };
        }
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          /* */
        }
      }
    } catch (err) {
      console.warn(
        '[telegram-capability] local STT failed, trying cloud fallback:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return transcribeVoiceCloud(audio, ext);
}

export async function transcribeVoiceUrl(url: string): Promise<TranscribeResult> {
  const res = await fetch(url);
  if (!res.ok) {
    return {
      text: `[voice error: download ${res.status}]`,
      engine: 'none',
      local: false,
    };
  }
  return transcribeVoiceBytes(Buffer.from(await res.arrayBuffer()), 'ogg');
}

async function transcribeVoiceCloud(audio: Buffer, ext: string): Promise<TranscribeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      text: '[voice unavailable — local adapter down and no OpenAI key]',
      engine: 'none',
      local: false,
    };
  }
  const tmp = join(tmpdir(), `voice_cloud_${Date.now()}.${ext}`);
  try {
    writeFileSync(tmp, audio);
    const form = new FormData();
    form.append('file', new Blob([readFileSync(tmp)], { type: `audio/${ext}` }), `voice.${ext}`);
    form.append('model', 'whisper-1');
    const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!wr.ok) {
      return {
        text: `[voice error: ${wr.status} — key may be expired]`,
        engine: 'openai-whisper-1',
        local: false,
      };
    }
    const data = (await wr.json()) as { text?: string };
    return {
      text: data.text?.trim() || '[empty transcription]',
      engine: 'openai-whisper-1',
      local: false,
    };
  } catch (e) {
    return {
      text: `[voice failed: ${e instanceof Error ? e.message : String(e)}]`,
      engine: 'openai-whisper-1',
      local: false,
    };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* */
    }
  }
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
