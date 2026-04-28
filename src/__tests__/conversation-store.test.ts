import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set MEMORY_ROOT before importing module
const TMP = join(tmpdir(), `atlas-conv-test-${Date.now()}`);
process.env['MEMORY_ROOT'] = TMP;

const CONV_DIR = join(TMP, 'memory', 'atlas', 'telegram-conversations');

import {
  appendMessage,
  parseJSONL,
  loadConversation,
  compactIfNeeded,
} from '../atlas/conversation-store.js';

beforeEach(() => {
  mkdirSync(CONV_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('conversation-store', () => {
  it('parseJSONL skips malformed lines and returns valid ones', () => {
    const lines = [
      '{"ts":"2026-01-01","role":"user","text":"hello"}',
      '{CORRUPT',
      '',
      '{"ts":"2026-01-02","role":"assistant","text":"hi"}',
      '{"role":"user","text":"unterm',
    ].join('\n');
    const parsed = parseJSONL(lines);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.text).toBe('hello');
    expect(parsed[1]!.text).toBe('hi');
  });

  it('appendMessage creates file and stores valid JSONL', async () => {
    await appendMessage(999, { ts: '2026-01-01T00:00:00Z', role: 'user', text: 'test' });
    const raw = readFileSync(join(CONV_DIR, '999.jsonl'), 'utf-8');
    const parsed = parseJSONL(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.text).toBe('test');
  });

  it('loadConversation returns last N messages', async () => {
    for (let i = 0; i < 30; i++) {
      await appendMessage(100, { ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`, role: 'user', text: `msg-${i}` });
    }
    const last5 = loadConversation(100, 5);
    expect(last5).toHaveLength(5);
    expect(last5[0]!.text).toBe('msg-25');
    expect(last5[4]!.text).toBe('msg-29');
  });

  it('compactIfNeeded trims file beyond MAX_LINES', async () => {
    const fp = join(CONV_DIR, '200.jsonl');
    const lines = Array.from({ length: 1100 }, (_, i) =>
      JSON.stringify({ ts: '2026-01-01', role: 'user', text: `line-${i}` })
    );
    writeFileSync(fp, '\n' + lines.join('\n'), 'utf-8');

    await compactIfNeeded(200);

    const raw = readFileSync(fp, 'utf-8');
    const parsed = parseJSONL(raw);
    expect(parsed.length).toBeLessThanOrEqual(600);
    expect(parsed[parsed.length - 1]!.text).toBe('line-1099');
  });

  it('concurrent writes produce separate valid lines', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      appendMessage(300, { ts: '2026-01-01', role: 'user', text: `concurrent-${i}` })
    );
    await Promise.all(promises);
    const parsed = loadConversation(300, 100);
    expect(parsed).toHaveLength(10);
    for (const msg of parsed) {
      expect(msg.text).toMatch(/^concurrent-\d$/);
    }
  });
});
