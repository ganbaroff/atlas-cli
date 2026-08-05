import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('telegram-capability', () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    process.env.ATLAS_VOICE_PREFER_LOCAL = '1';
    process.env.ATLAS_DOCS_PREFER_LOCAL = '1';
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_STT_ACCESS_TOKEN;
  });

  afterEach(() => {
    process.env = env;
    vi.restoreAllMocks();
  });

  it('prefers local voice adapter when healthy (sensitive default)', async () => {
    vi.doMock('../atlas/voice-adapter-client.js', () => ({
      voiceHealth: vi.fn().mockResolvedValue({ ok: true }),
      voiceStt: vi.fn().mockResolvedValue({
        text: 'Доброе утро',
        engine: 'gigaam-v3-ctc-onnx-int8',
      }),
      voiceCloudPolicy: vi.fn().mockResolvedValue({
        allowCloud: false,
        reason: 'sensitive audio stays local-only (ADR-0010)',
        order: ['groq', 'google-cloud', 'gemini'],
      }),
    }));

    const { transcribeVoiceBytes } = await import('../atlas/telegram-capability.js');
    const out = await transcribeVoiceBytes(Buffer.from('fake'), 'ogg');
    expect(out.local).toBe(true);
    expect(out.text).toBe('Доброе утро');
    expect(out.engine).toContain('gigaam');
  });

  it('F2: sensitive audio never reaches OpenAI when local is down', async () => {
    vi.doMock('../atlas/voice-adapter-client.js', () => ({
      voiceHealth: vi.fn().mockRejectedValue(new Error('connection refused')),
      voiceCloudPolicy: vi.fn().mockResolvedValue({
        allowCloud: false,
        reason: 'sensitive audio stays local-only (ADR-0010)',
        order: ['groq', 'google-cloud', 'gemini'],
      }),
    }));
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GROQ_API_KEY = 'gsk-test';
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    const { transcribeVoiceBytes } = await import('../atlas/telegram-capability.js');
    const out = await transcribeVoiceBytes(Buffer.from('fake'), 'ogg', { sensitive: true });
    expect(out.local).toBe(false);
    expect(out.engine).toBe('none');
    expect(out.text).toMatch(/sensitive audio local-only/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('F2: ATLAS_VOICE_PREFER_LOCAL=0 cannot bypass sensitive local-only', async () => {
    process.env.ATLAS_VOICE_PREFER_LOCAL = '0';
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.doMock('../atlas/voice-adapter-client.js', () => ({
      voiceHealth: vi.fn().mockRejectedValue(new Error('down')),
      voiceCloudPolicy: vi.fn().mockResolvedValue({
        allowCloud: false,
        reason: 'sensitive audio stays local-only (ADR-0010)',
        order: ['groq', 'google-cloud', 'gemini'],
      }),
    }));
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    const { transcribeVoiceBytes } = await import('../atlas/telegram-capability.js');
    const out = await transcribeVoiceBytes(Buffer.from('x'), 'ogg', { sensitive: true });
    expect(out.text).toMatch(/sensitive audio local-only/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('F1: non-sensitive uses Groq before OpenAI', async () => {
    process.env.ATLAS_VOICE_PREFER_LOCAL = '0';
    process.env.GROQ_API_KEY = 'gsk-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.doMock('../atlas/voice-adapter-client.js', () => ({
      voiceHealth: vi.fn().mockRejectedValue(new Error('down')),
      voiceCloudPolicy: vi.fn().mockResolvedValue({
        allowCloud: true,
        reason: 'non-sensitive may use free-first cloud ladder',
        order: ['groq', 'google-cloud', 'gemini'],
      }),
    }));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'from groq' }),
    }) as typeof fetch;

    const { transcribeVoiceBytes } = await import('../atlas/telegram-capability.js');
    const out = await transcribeVoiceBytes(Buffer.from('fake'), 'ogg', { sensitive: false });
    expect(out.local).toBe(false);
    expect(out.text).toBe('from groq');
    expect(out.engine).toBe('groq-whisper');
    const url = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
    expect(url).toContain('api.groq.com');
    expect(url).not.toContain('api.openai.com');
  });
});
