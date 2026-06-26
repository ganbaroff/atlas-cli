/**
 * Atlas Telegram bot — rewritten for reliability.
 * Direct Telegram polling with multi-provider model fallback. One file.
 */

// CWD-FIX (stitch-breaker): resolve .env + operator/state from module dir,
// not process.cwd(). Without this, launching from any dir other than ANUS root
// → "No models available" + operator crash. See breadcrumb 2026-06-26 15:30.
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ANUS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(ANUS_ROOT, '.env') });
process.chdir(ANUS_ROOT);
import { Telegraf } from 'telegraf';
import { Agent } from '@mastra/core/agent';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeReplyGate } from './atlas/reply-gates.js';
import { deliverReply } from './atlas/reply-delivery.js';
import { extractTurnEvidence, type TurnEvidenceSource } from './atlas/turn-evidence.js';
import {
  applyControlCommand,
  controlAllowsModelCalls,
  describeControlBlock,
  parseControlCommand,
} from './atlas/control-plane.js';
import { buildAtlasBrainPlan } from './atlas/brain-planner.js';
import { appendMessage, loadConversation, compactIfNeeded, type StoredMessage } from './atlas/conversation-store.js';
import { listAvailableModels, routeModelWithFallback } from './model-router.js';
import { analyzeWindow, emotionDirective } from './atlas/emotion.js';
import { loadPulse, savePulse, processEvent, pulseToneHint } from './atlas/pulse.js';
import { runOperatorActionLane } from './operator/action-lane.js';
import { runSwarm } from './swarm.js';

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
        evidence: extractTurnEvidence(response),
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

// Time-based write-back — fires every 5 minutes regardless of message count.
// Message-count approach failed: sendMessage API doesn't trigger addMsg, and
// low traffic means write-back never fires.
const WRITEBACK_MS = 5 * 60 * 1000;
setInterval(() => {
  writeSessionSummary()
    .then(() => console.log('[memory] periodic write-back OK'))
    .catch(err => console.error('[memory] periodic write-back failed:', err));
}, WRITEBACK_MS);

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

  const operatorAction = runOperatorActionLane(text, { source: 'telegram' });
  if (operatorAction.handled) {
    addMsg(chatId, 'assistant', operatorAction.reply);
    return operatorAction.reply;
  }

  const controlCommand = parseControlCommand(text);
  if (controlCommand) {
    const result = applyControlCommand(controlCommand, 'telegram');
    addMsg(chatId, 'assistant', result.message);
    return result.message;
  }

  if (!controlAllowsModelCalls()) {
    const blocked = describeControlBlock();
    addMsg(chatId, 'assistant', blocked);
    return blocked;
  }

  const messages = buildMessages(chatId);
  console.log(`[in]  chat=${chatId} msg="${text.slice(0, 100)}"`);

  // Emotion layer: read CEO state over the last 2-3 user messages (05-emotional-states.md:59),
  // update Atlas's own Pulse, persist MOOD.md. Both bias TONE only — never facts, never refusals.
  const userWindow = getConvo(chatId)
    .msgs.filter((m) => m.role === 'user')
    .slice(-3)
    .reverse()
    .map((m) => m.content);
  const ceoRead = analyzeWindow(userWindow);
  const pulse = processEvent(loadPulse(), 'ceo', 'user_feedback');
  savePulse(pulse.state, `telegram message, CEO read: ${ceoRead.state}`);
  console.log(
    `[emotion] chat=${chatId} ceo=${ceoRead.state}/${ceoRead.intensity} pulse-int=${pulse.intensity.toFixed(2)}${pulse.wouldBlock ? ' [would-block: log-only]' : ''}`,
  );

  const basePrompt = (await buildAtlasBrainPlan({ channel: 'telegram' })).systemPrompt;
  // Inject actual model identity so the LLM doesn't hallucinate being a different model
  const modelIdentity = `[RUNTIME: You are running on ${availableModels[0]?.provider ?? 'unknown'}/${availableModels[0]?.modelId ?? 'unknown'}. Do NOT claim to be Claude, GPT, or any other model. You are Atlas, powered by whatever model the router selected.]`;
  const system = `${basePrompt}\n\n${modelIdentity}\n${emotionDirective(ceoRead)}\n${pulseToneHint(pulse.state)}`;
  const firstPass = await generateWithFallback(messages, system);
  console.log(`[out] chat=${chatId} provider=${firstPass.provider}/${firstPass.modelId} reply="${firstPass.reply.slice(0, 100)}"`);
  const delivery = await deliverReply(firstPass.reply, async (prompt) => {
    const retry = await generateWithFallback(
      [...messages, { role: 'user', content: prompt }],
      system,
    );
    console.log(`[out-retry] chat=${chatId} provider=${retry.provider}/${retry.modelId} reply="${retry.reply.slice(0, 100)}"`);
    return {
      reply: retry.reply,
      evidence: retry.evidence,
    };
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

// ── Telegram message splitting (4096 char limit) ───────────────────
const TG_LIMIT = 4096;
async function sendLong(ctx: any, text: string): Promise<void> {
  if (text.length <= TG_LIMIT) { await ctx.reply(text); return; }
  for (let i = 0; i < text.length; i += TG_LIMIT) {
    await ctx.reply(text.slice(i, i + TG_LIMIT));
  }
}

// ── Swarm trigger detection ────────────────────────────────────────
const SWARM_TRIGGERS = /^(?:\/swarm|рой|swarm)\b/i;
function isSwarmRequest(text: string): { isSwarm: boolean; task: string } {
  const match = text.match(SWARM_TRIGGERS);
  if (!match) return { isSwarm: false, task: '' };
  return { isSwarm: true, task: text.slice(match[0].length).trim() || text };
}

// ── Bot handlers ────────────────────────────────────────────────────
bot.command('status', async (ctx) => {
  const chatId = ctx.chat.id;
  await ctx.reply('[atlas] Проверяю статус экосистемы...');
  try {
    const { execSync } = await import('node:child_process');
    const statusScript = 'C:/Projects/ATLAS/scripts/status.mjs';
    const out = execSync(`node "${statusScript}" --json`, {
      cwd: 'C:/Projects/ATLAS',
      timeout: 15_000,
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const data = JSON.parse(out);
    const wakes = (data.wake_signals ?? []).map((s: any) => `  ⚠ ${s.subject}: ${s.detail?.slice(0, 80)}`);
    const queued = (data.queue_signals ?? []).map((s: any) => `  · ${s.subject}: ${s.detail?.slice(0, 60)}`);
    const stale = (data.stale_agents ?? []).map((a: any) => `  · ${a.agent_id} (${a.age_hours}h)`);
    const dirty = (data.dirty_repos ?? []).map((r: any) => `${r.path.split('/').pop()}=${r.count}`);
    const lines = [
      `Atlas Status — ${new Date(data.time).toLocaleString('ru-RU', { timeZone: 'Asia/Baku' })}`,
      '',
      `Prod: ${data.prod_health?.status ?? '?'} (v${data.prod_health?.version ?? '?'}, sha ${data.prod_health?.sha?.slice(0, 7) ?? '?'})`,
      '',
      wakes.length ? `Wake (${wakes.length}):` : 'Wake: 0',
      ...wakes,
      '',
      queued.length ? `Queue (${queued.length}):` : 'Queue: 0',
      ...queued.slice(0, 3),
      queued.length > 3 ? `  ...и ещё ${queued.length - 3}` : '',
      '',
      stale.length ? `Stale agents (${stale.length}):` : 'Stale: 0',
      ...stale,
      '',
      `Dirty: ${dirty.join(', ') || 'clean'}`,
    ].filter(Boolean);
    const reply = lines.join('\n');
    addMsg(chatId, 'user', '/status');
    addMsg(chatId, 'assistant', reply);
    await ctx.reply(reply);
  } catch (e) {
    const err = `Status check failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    await ctx.reply(err);
    console.error('[status error]', e);
  }
});

bot.command('models', async (ctx) => {
  const models = listAvailableModels();
  const lines = models.map(m => `${m.provider}/${m.modelId} (tier ${m.costTier}, ${m.roles.join('/')})`);
  const reply = `Available models (${models.length}):\n${lines.join('\n')}`;
  await ctx.reply(reply);
});

bot.command('run', async (ctx) => {
  const cmd = ctx.message.text.replace(/^\/run\s*/, '').trim();
  if (!cmd) {
    await ctx.reply('Usage: /run <shell command>\nПримеры: /run git status, /run ls C:/Projects');
    return;
  }
  const chatId = ctx.chat.id;

  // Safety: block destructive/secret-touching commands
  const BLOCKED = /rm\s+-rf|del\s+\/[sfq]|format\s|shutdown|reboot|mkfs|dd\s+if|>\s*\/dev|password|secret|token|api.key/i;
  if (BLOCKED.test(cmd)) {
    await ctx.reply('Заблокировано: команда содержит потенциально опасный паттерн.');
    return;
  }

  addMsg(chatId, 'user', `/run ${cmd}`);
  await ctx.reply(`[run] $ ${cmd.slice(0, 60)}...`);

  try {
    const { execSync } = await import('node:child_process');
    const output = execSync(cmd, {
      timeout: 30_000,
      encoding: 'utf-8',
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      maxBuffer: 1024 * 1024,
    }).trim();
    const result = output.slice(0, 3800) || '(empty output)';
    addMsg(chatId, 'assistant', result);
    await sendLong(ctx, result);
    console.log(`[run] chat=${chatId} cmd="${cmd.slice(0, 60)}" output=${output.length} chars`);
  } catch (e: any) {
    const stderr = e.stderr?.toString()?.slice(0, 500) || e.message?.slice(0, 500) || 'unknown error';
    const reply = `Exit ${e.status ?? '?'}: ${stderr}`;
    addMsg(chatId, 'assistant', reply);
    await ctx.reply(reply.slice(0, 4096));
    console.error(`[run] chat=${chatId} cmd="${cmd.slice(0, 60)}" FAILED: ${stderr.slice(0, 100)}`);
  }
});

bot.command('swarm', async (ctx) => {
  const task = ctx.message.text.replace(/^\/swarm\s*/, '').trim();
  if (!task) {
    await ctx.reply('Usage: /swarm <task>\nРой проанализирует задачу с нескольких перспектив.');
    return;
  }
  const chatId = ctx.chat.id;
  addMsg(chatId, 'user', `/swarm ${task}`);
  await ctx.reply('[swarm] Запускаю рой — несколько перспектив параллельно...');
  try {
    const result = await runSwarm(task);
    addMsg(chatId, 'assistant', result);
    await sendLong(ctx, result);
    console.log(`[swarm] chat=${chatId} task="${task.slice(0, 80)}" result=${result.length} chars`);
  } catch (e) {
    const err = `Рой упал: ${e instanceof Error ? e.message : String(e)}`;
    addMsg(chatId, 'assistant', err);
    await ctx.reply(err);
    console.error('[swarm error]', e);
  }
});

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
    const text = ctx.message.text;
    const chatId = ctx.chat.id;

    // Natural language swarm trigger: "рой, ..." or "swarm ..."
    const swarmCheck = isSwarmRequest(text);
    if (swarmCheck.isSwarm && swarmCheck.task) {
      addMsg(chatId, 'user', text);
      await ctx.reply('[swarm] Запускаю рой...');
      const result = await runSwarm(swarmCheck.task);
      addMsg(chatId, 'assistant', result);
      await sendLong(ctx, result);
      console.log(`[swarm] chat=${chatId} trigger="${text.slice(0, 40)}" result=${result.length} chars`);
      return;
    }

    const reply = await ask(chatId, text);
    await sendLong(ctx, reply);
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

// ── Session write-back on shutdown (v1 bar: memory across sessions) ──
import { appendJournal, writeHeartbeat } from './atlas/memory-manager.js';

async function writeSessionSummary(): Promise<void> {
  try {
    const sessionChats = Array.from(convos.entries());
    const totalMsgs = sessionChats.reduce((sum, [, c]) => sum + c.msgs.length, 0);
    const topics = sessionChats
      .flatMap(([, c]) => c.msgs.filter(m => m.role === 'user').map(m => m.content.slice(0, 60)))
      .slice(-5);

    // Always write heartbeat (proves bot is alive), journal only if there are messages
    await writeHeartbeat({
      source: 'telegram',
      chats: sessionChats.length,
      messages: totalMsgs,
      providers: availableModels.map(m => `${m.provider}/${m.modelId}`).join(', '),
      uptime: `${Math.round((Date.now() - new Date(bootTime).getTime()) / 60000)}min`,
    });

    if (sessionChats.length === 0) return;

    const entry = [
      `## Telegram session — ${new Date().toISOString()}`,
      '',
      `Chats: ${sessionChats.length}, Messages: ${totalMsgs}`,
      `Models used: ${availableModels.map(m => m.provider).join(', ')}`,
      '',
      `### Last topics`,
      ...topics.map(t => `- ${t}`),
    ].join('\n');

    await appendJournal(entry);
    console.log(`[memory] session summary written: ${totalMsgs} msgs across ${sessionChats.length} chats`);
  } catch (e) {
    console.error('[memory] write-back failed:', e);
  }
}

// ── Launch with crash recovery ──────────────────────────────────────
function fatal(label: string, error: unknown): never {
  console.error(label, error);
  process.exit(1);
}

const bootTime = new Date().toISOString();
async function boot(): Promise<void> {
  void bot.launch(() => {
    console.log(`[bot] Atlas Telegram alive @${bot.botInfo?.username ?? 'unknown'} — ${bootTime} fallback=routeModelWithFallback providers=${availableModels.map((m) => m.provider).join(',')}`);
  }).catch((error) => fatal('[LAUNCH FAILED]', error));
}
boot().catch((error) => fatal('[BOOT FAILED]', error));

async function gracefulStop(signal: string): Promise<void> {
  console.log(`[bot] ${signal} received, writing session summary...`);
  await writeSessionSummary();
  bot.stop(signal);
}

process.once('SIGINT', () => { gracefulStop('SIGINT').catch(() => process.exit(0)); });
process.once('SIGTERM', () => { gracefulStop('SIGTERM').catch(() => process.exit(0)); });
process.on('uncaughtException', (e) => fatal('[CRASH]', e));
process.on('unhandledRejection', (e) => fatal('[UNHANDLED]', e));
