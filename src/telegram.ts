/**
 * Atlas Telegram bot — rewritten for reliability.
 * Direct Telegram polling with multi-provider model fallback. One file.
 */

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { Agent } from '@mastra/core/agent';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeReplyGate } from './atlas/reply-gates.js';
import { BRIEFING_TEMPLATE } from './atlas/briefing.js';
import { deliverReply } from './atlas/reply-delivery.js';
import type { TurnEvidenceSource } from './gates/verify-completion-walk.js';
import { loadLessons } from './atlas/memory-manager.js';
import { appendMessage, loadConversation, compactIfNeeded, type StoredMessage } from './atlas/conversation-store.js';
import { listAvailableModels, routeModelWithFallback } from './model-router.js';

// ── Env verification ────────────────────────────────────────────────
const REQUIRED = ['TELEGRAM_BOT_TOKEN'] as const;
for (const key of REQUIRED) {
  if (!process.env[key]) { console.error(`FATAL: ${key} missing from .env`); process.exit(1); }
}

if (!process.env['OLLAMA_URL'] && !process.env['OLLAMA_HOST']) {
  process.env['OLLAMA_URL'] = 'http://127.0.0.1:11434';
  console.log('[model] defaulting to local Ollama at http://127.0.0.1:11434');
}

const bot = new Telegraf(process.env['TELEGRAM_BOT_TOKEN']!);
const availableModels = listAvailableModels();
if (availableModels.length === 0) {
  console.error('FATAL: no model provider keys configured in .env');
  process.exit(1);
}

// ── Brain — loaded once, cached in RAM ──────────────────────────────
const BRAIN_PATH = join(
  process.env['MEMORY_ROOT'] ?? (process.platform === 'win32' ? 'C:\\Projects\\VOLAURA' : join(process.env['HOME'] ?? '~', 'Projects', 'VOLAURA')),
  'memory', 'atlas', 'TELEGRAM-BRAIN.md',
);
const BRAIN = existsSync(BRAIN_PATH) ? readFileSync(BRAIN_PATH, 'utf-8') : 'You are Atlas, AI assistant for VOLAURA. Respond in Russian unless asked otherwise.';
let SYSTEM = `${BRAIN}\n\n${BRIEFING_TEMPLATE}\n\nToday: ${new Date().toISOString().slice(0, 10)}. You are talking to CEO Yusif via Telegram. Be concise.`;
console.log(`[brain] loaded ${BRAIN.length} chars from ${existsSync(BRAIN_PATH) ? BRAIN_PATH : 'fallback'}`);

// Lessons loaded before bot.launch() — no race condition
async function injectLessons(): Promise<void> {
  try {
    const lessons = await loadLessons(true);
    if (lessons) {
      SYSTEM += `\n\n## LESSONS (never repeat these mistakes)\n${lessons}`;
      console.log(`[lessons] injected ${lessons.length} chars into system prompt`);
    }
  } catch { /* vault unreachable — continue without lessons */ }
}

type ModelReply = {
  modelId: string;
  provider: string;
  reply: string;
  evidence: TurnEvidenceSource;
};

async function generateWithFallback(
  messages: Msg[],
  system: string,
): Promise<ModelReply> {
  const { result } = await routeModelWithFallback(
    { role: 'WORKER' },
    async (route) => {
      const agent = new Agent({
        id: 'atlas-telegram',
        name: 'Atlas',
        instructions: system,
        model: route.model,
      });
      const response = route.provider === 'ollama'
        ? await agent.generateLegacy(messages as any)
        : await agent.generate(messages as any);
      return {
        modelId: route.modelId,
        provider: route.provider,
        reply: response.text,
        evidence: {
          steps: response.steps as TurnEvidenceSource['steps'],
          toolCalls: response.toolCalls as TurnEvidenceSource['toolCalls'],
          toolResults: response.toolResults as TurnEvidenceSource['toolResults'],
        } satisfies TurnEvidenceSource,
      } satisfies ModelReply;
    },
  );

  return result as ModelReply;
}

// ── Conversation history — in-memory + persistent JSONL ────────────
type Msg = { role: 'user' | 'assistant'; content: string };
const convos = new Map<number, { msgs: Msg[]; summary: string; restored: boolean }>();

function getConvo(chatId: number) {
  if (!convos.has(chatId)) {
    const restored = loadConversation(chatId, 20);
    const msgs: Msg[] = restored.map(m => ({ role: m.role, content: m.text }));
    convos.set(chatId, { msgs, summary: '', restored: restored.length > 0 });
    if (restored.length > 0) console.log(`[memory] restored ${restored.length} messages for chat ${chatId}`);
  }
  return convos.get(chatId)!;
}

function addMsg(chatId: number, role: 'user' | 'assistant', content: string) {
  const c = getConvo(chatId);
  c.msgs.push({ role, content });

  appendMessage(chatId, {
    ts: new Date().toISOString(),
    role,
    text: content,
  }).catch(err => console.error('[memory] write failed:', err));

  if (c.msgs.length > 20) {
    const old = c.msgs.splice(0, c.msgs.length - 10);
    const snippet = old.map(m => `${m.role}: ${m.content.slice(0, 80)}`).join(' | ');
    c.summary = c.summary ? `${c.summary}\n${snippet}` : snippet;
    if (c.summary.length > 2000) c.summary = c.summary.slice(-2000);
    compactIfNeeded(chatId).catch(err => console.error('[compact] failed:', err));
  }
}

function buildMessages(chatId: number): Msg[] {
  const c = getConvo(chatId);
  const result: Msg[] = [];
  if (c.summary) result.push({ role: 'user', content: `[Earlier conversation summary: ${c.summary}]` });
  // Ensure first message is always 'user' role
  const start = c.msgs.findIndex(m => m.role === 'user');
  if (start >= 0) result.push(...c.msgs.slice(start));
  else result.push(...c.msgs);
  return result.length > 0 ? result : [{ role: 'user', content: '(empty)' }];
}

// ── LLM call ────────────────────────────────────────────────────────
async function ask(chatId: number, text: string): Promise<string> {
  addMsg(chatId, 'user', text);
  const messages = buildMessages(chatId);
  console.log(`[in]  chat=${chatId} msg="${text.slice(0, 100)}"`);

  const firstPass = await generateWithFallback(messages, SYSTEM);
  console.log(`[out] chat=${chatId} provider=${firstPass.provider}/${firstPass.modelId} reply="${firstPass.reply.slice(0, 100)}"`);
  const delivery = await deliverReply(firstPass.reply, async (prompt) => {
    const retry = await generateWithFallback(
      [...messages, { role: 'user', content: prompt }],
      SYSTEM,
    );
    console.log(`[out-retry] chat=${chatId} provider=${retry.provider}/${retry.modelId} reply="${retry.reply.slice(0, 100)}"`);
    return retry.reply;
  }, firstPass.evidence);
  const reply = delivery.reply;
  if (delivery.repaired.retried) {
    console.warn(`[reply-gate] chat=${chatId} ${summarizeReplyGate(delivery.repaired.firstPass)} -> ${summarizeReplyGate(delivery.repaired.retryPass ?? delivery.repaired.firstPass)}`);
  }
  if (!delivery.emitDecision.emitOriginalReply) {
    console.warn(`[verify_completion_walk] chat=${chatId} ${delivery.emitDecision.reason ?? 'blocked'} proof=${delivery.emitDecision.proofTokens.length}`);
  }
  console.log(`[out-final] chat=${chatId} reply="${reply.slice(0, 100)}"`);

  const finalReply = reply.trim() || 'Молчу. Повтори?';
  addMsg(chatId, 'assistant', finalReply);
  return finalReply;
}

// ── Voice transcription — graceful fallback ─────────────────────────
async function transcribe(fileUrl: string): Promise<string> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) return '[voice unavailable — no OpenAI key]';

  const tmp = join(tmpdir(), `voice_${Date.now()}.ogg`);
  try {
    const res = await fetch(fileUrl);
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const form = new FormData();
    form.append('file', new Blob([readFileSync(tmp)], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', 'whisper-1');
    const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    });
    if (!wr.ok) return `[voice error: ${wr.status} — key may be expired]`;
    const data = (await wr.json()) as { text?: string };
    return data.text?.trim() || '[empty transcription]';
  } catch (e) {
    return `[voice failed: ${e instanceof Error ? e.message : String(e)}]`;
  } finally {
    try { unlinkSync(tmp); } catch { /* */ }
  }
}

// ── Bot handlers ────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  convos.delete(chatId);
  try {
    const reply = await ask(chatId, '/start — new session started');
    await ctx.reply(reply);
  } catch (e) {
    console.error('[/start error]', e);
    await ctx.reply('Ошибка при запуске. Попробуй снова.');
  }
});

bot.on('text', async (ctx) => {
  try {
    const reply = await ask(ctx.chat.id, ctx.message.text);
    await ctx.reply(reply);
  } catch (e) {
    console.error('[text error]', e);
    await ctx.reply('Внутренняя ошибка. Попробуй снова.');
  }
});

bot.on('voice', async (ctx) => {
  try {
    const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const text = await transcribe(link.href);
    if (text.startsWith('[')) { await ctx.reply(text); return; }
    await ctx.reply(`[voice] ${text}`);
    const reply = await ask(ctx.chat.id, text);
    await ctx.reply(reply);
  } catch (e) {
    console.error('[voice error]', e);
    await ctx.reply('Ошибка голосового сообщения. Попробуй текстом.');
  }
});

// ── Launch with crash recovery ──────────────────────────────────────
function fatal(label: string, error: unknown): never {
  console.error(label, error);
  process.exit(1);
}

async function boot(): Promise<void> {
  await injectLessons();
  void bot.launch(() => {
    console.log(`[bot] Atlas Telegram alive @${bot.botInfo?.username ?? 'unknown'} — ${new Date().toISOString()} fallback=routeModelWithFallback providers=${availableModels.map((m) => m.provider).join(',')}`);
  }).catch((error) => fatal('[LAUNCH FAILED]', error));
}
boot().catch((error) => fatal('[BOOT FAILED]', error));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.on('uncaughtException', (e) => fatal('[CRASH]', e));
process.on('unhandledRejection', (e) => fatal('[UNHANDLED]', e));
