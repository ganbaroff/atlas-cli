import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('telegram-capability', () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    process.env.ATLAS_VOICE_PREFER_LOCAL = '1';
    process.env.ATLAS_DOCS_PREFER_LOCAL = '1';
  });

  afterEach(() => {
    process.env = env;
    vi.restoreAllMocks();
  });

  it('prefers local voice adapter when healthy', async () => {
    vi.doMock('../atlas/voice-adapter-client.js', () => ({
      voiceHealth: vi.fn().mockResolvedValue({ ok: true }),
      voiceStt: vi.fn().mockResolvedValue({
        text: 'Доброе утро',
        engine: 'gigaam-v3-ctc-onnx-int8',
      }),
    }));

    const { transcribeVoiceBytes } = await import('../atlas/telegram-capability.js');
    const out = await transcribeVoiceBytes(Buffer.from('fake'), 'ogg');
    expect(out.local).toBe(true);
    expect(out.text).toBe('Доброе утро');
    expect(out.engine).toContain('gigaam');
  });

  it('falls back to cloud when local adapter fails', async () => {
    vi.doMock('../atlas/voice-adapter-client.js', () => ({
      voiceHealth: vi.fn().mockRejectedValue(new Error('connection refused')),
    }));
    process.env.OPENAI_API_KEY = 'sk-test';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello' }),
    }) as typeof fetch;

    const { transcribeVoiceBytes } = await import('../atlas/telegram-capability.js');
    const out = await transcribeVoiceBytes(Buffer.from('fake'), 'ogg');
    expect(out.local).toBe(false);
    expect(out.text).toBe('hello');
    expect(out.engine).toBe('openai-whisper-1');
  });

  it('voicePreferLocal respects ATLAS_VOICE_PREFER_LOCAL=0', async () => {
    process.env.ATLAS_VOICE_PREFER_LOCAL = '0';
    process.env.OPENAI_API_KEY = 'sk-test';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'cloud only' }),
    }) as typeof fetch;

    const { transcribeVoiceBytes } = await import('../atlas/telegram-capability.js');
    const out = await transcribeVoiceBytes(Buffer.from('x'), 'ogg');
    expect(out.local).toBe(false);
    expect(out.text).toBe('cloud only');
  });
});
