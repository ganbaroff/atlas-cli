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
// .env optional — on Railway env vars come from dashboard, not file
import { existsSync } from 'node:fs';
const envPath = resolve(ANUS_ROOT, '.env');
if (existsSync(envPath)) config({ path: envPath });
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
import { runTask, isTaskRunning } from './atlas/task-spawner.js';
import { executeDeploy, deployInProgress, getPR, listOpenPRs } from './atlas/deploy.js';
import { appendMessage, loadConversation, compactIfNeeded, type StoredMessage } from './atlas/conversation-store.js';
import { isSupabaseConfigured, createSession, saveMessage, loadMessages, writeHeartbeatDB, writeJournalDB, writeEpisodeDB, updateSession, getLatestSession, queueRemoteCommand, pollCompletedCommands, deleteDeliveredCommand } from './atlas/supabase-memory.js';
import { formatReceipt } from './atlas/receipt.js';
import { listAvailableModels, routeModelWithFallback } from './model-router.js';
import { recordSpendFromResult } from './atlas/spend-tracker.js';
import { enforceSpendPolicy, isPaused, tryConsumeBrainQueueSlot, brainQueueCap } from './atlas/spend-policy.js';
import { analyzeWindow, emotionDirective } from './atlas/emotion.js';
import { loadPulse, savePulse, processEvent, pulseToneHint } from './atlas/pulse.js';
import { runOperatorActionLane } from './operator/action-lane.js';
import { runSwarm } from './swarm.js';

// ── Env verification ────────────────────────────────────────────────
const REQUIRED = ['TELEGRAM_BOT_TOKEN'] as const;
for (const key of REQUIRED) {
  if (!process.env[key]) throw new Error(`FATAL: ${key} missing from .env`);
}

if (!process.env['OLLAMA_URL'] && !process.env['OLLAMA_HOST']) {
  process.env['OLLAMA_URL'] = 'http://127.0.0.1:11434';
  console.log('[model] defaulting to local Ollama at http://127.0.0.1:11434');
}

const bot = new Telegraf(process.env['TELEGRAM_BOT_TOKEN']!);
const availableModels = listAvailableModels();
if (availableModels.length === 0) {
  throw new Error('FATAL: no model provider keys configured in .env');
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
  caller = 'telegram',
): Promise<ModelReply> {
  const { result } = await routeModelWithFallback(
    { role: 'WORKER' },
    async (route) => {
      // FinOps gateway: block paid providers over cap / behind flag before spending.
      enforceSpendPolicy(route.provider, caller);
      const agent = new Agent({
        id: 'atlas-telegram',
        name: 'Atlas',
        instructions: system,
        model: route.model,
      });
      const response = route.provider === 'ollama'
        ? await agent.generateLegacy(messages as any)
        : await agent.generate(messages as any);
      // FinOps telemetry: one llm_spend row per real call (non-blocking).
      recordSpendFromResult(response, { provider: route.provider, model: route.modelId, caller });
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

let msgCount = 0;
const WRITEBACK_INTERVAL = 10; // write heartbeat every N messages

// Track active Supabase session per chat
const dbSessions = new Map<number, string>();

function addMsg(chatId: number, role: 'user' | 'assistant', content: string, provider?: string, model?: string) {
  const c = getConvo(chatId);
  c.msgs.push({ role, content });

  // JSONL fallback (always — local dev, Railway without Supabase, etc.)
  appendMessage(chatId, {
    ts: new Date().toISOString(),
    role,
    text: content,
  }).catch(err => console.error('[memory] write failed:', err));

  // Supabase (primary when configured — survives redeploy)
  if (isSupabaseConfigured()) {
    (async () => {
      let sid = dbSessions.get(chatId);
      if (!sid) {
        sid = await createSession(chatId);
        dbSessions.set(chatId, sid);
      }
      await saveMessage(sid, chatId, { role, content, provider, model });
      await updateSession(sid, { message_count: c.msgs.length });
    })().catch(err => console.error('[supabase] message save failed:', err));
  }

  // Periodic write-back — don't rely on graceful shutdown (Class 7 on SIGTERM)
  msgCount++;
  if (msgCount % WRITEBACK_INTERVAL === 0) {
    writeSessionSummary().catch(err => console.error('[memory] periodic write-back failed:', err));
  }

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
// Action intent detection — CEO says "проверь прод" → Atlas runs the command
const ACTION_PATTERNS = [
  { pattern: /проверь\s+прод|check\s+prod|prod\s+health/i, cmd: 'curl -s https://volauraapi-production.up.railway.app/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\\"prod: {d[\'status\']} sha:{d[\'git_sha\'][:7]}\\")' },
  { pattern: /git\s+status|статус\s+гит|что\s+в\s+гите/i, cmd: 'cd C:/Projects/VOLAURA && git log --oneline -3 && echo "---" && git status --short | head -10' },
  { pattern: /бот\s+жив|bot\s+alive|pm2\s+status/i, cmd: 'pm2 status' },
  { pattern: /atlas\s+status|статус\s+атлас|дашборд/i, cmd: 'cd C:/Projects/ATLAS && node scripts/status.mjs 2>&1 | head -20' },
];

function detectActionIntent(text: string): string | null {
  for (const { pattern, cmd } of ACTION_PATTERNS) {
    if (pattern.test(text)) return cmd;
  }
  return null;
}

async function ask(chatId: number, text: string): Promise<string> {
  addMsg(chatId, 'user', text);

  // Auto-action: CEO asks about prod/git/bot → Atlas runs the check and includes result
  const autoCmd = detectActionIntent(text);
  if (autoCmd) {
    try {
      const { execSync } = await import('node:child_process');
      const output = execSync(autoCmd, { timeout: 15_000, encoding: 'utf-8', maxBuffer: 512 * 1024 }).trim();
      console.log(`[auto-action] chat=${chatId} cmd="${autoCmd.slice(0, 50)}" output=${output.length} chars`);
      // Feed the output into the LLM so it can respond naturally with real data
      addMsg(chatId, 'user', `[system: auto-check result]\n${output.slice(0, 2000)}`);
    } catch (e: any) {
      addMsg(chatId, 'user', `[system: auto-check failed] ${e.message?.slice(0, 200)}`);
    }
  }

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
  const system = `${basePrompt}\n\n${emotionDirective(ceoRead)}\n${pulseToneHint(pulse.state)}`;
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

// Deploy with confirmation — auditor: no instant merge on typo
const pendingDeploys = new Map<number, { project: string; prNumber: number; prTitle: string; createdAt: number }>();

bot.command('deploy', async (ctx) => {
  const args = ctx.message.text.replace(/^\/deploy\s*/, '').trim().split(/\s+/);
  const project = args[0] || 'volaura';
  const prNum = args[1] ? parseInt(args[1], 10) : undefined;
  const chatId = ctx.chat.id;

  if (deployInProgress()) { await ctx.reply('Deploy уже идёт. Жди.'); return; }

  const pr = getPR(project, prNum);
  if (!pr) { await ctx.reply(`No PR found for ${project}${prNum ? ` #${prNum}` : ''}.`); return; }

  pendingDeploys.set(chatId, { project, prNumber: pr.number, prTitle: pr.title, createdAt: Date.now() });
  await ctx.reply(`Deploy PR #${pr.number} "${pr.title.slice(0, 50)}" в ${project}?\n\nНапиши "да" для подтверждения.`);
});

bot.hears(/^да$/i, async (ctx) => {
  const chatId = ctx.chat.id;
  const pending = pendingDeploys.get(chatId);
  if (!pending) return;
  // Audit #4: TTL — expire after 5 minutes to prevent stale deploy on unrelated "да"
  if (Date.now() - (pending.createdAt ?? 0) > 5 * 60 * 1000) {
    pendingDeploys.delete(chatId);
    await ctx.reply('Deploy request expired (>5 min). Start new /deploy.');
    return;
  }
  pendingDeploys.delete(chatId);

  addMsg(chatId, 'user', `deploy confirmed: ${pending.project} PR #${pending.prNumber}`);
  await ctx.reply(`[deploy] Мержу PR #${pending.prNumber} → main → polling health...\n~2 мин.`);

  try {
    const result = await executeDeploy(pending.project, pending.prNumber);
    const baseReply = result.error
      ? `[deploy FAIL] ${result.error}${result.rolledBack ? ' (ROLLED BACK)' : ''}`
      : `[deploy OK] PR #${result.prNumber} merged.\nProd: ${result.healthCheck?.status} sha:${result.healthCheck?.sha}\n${Math.round(result.durationMs / 1000)}s`;
    const reply = `${baseReply}\n\n${formatReceipt(
      `deploy ${pending.project} PR #${pending.prNumber}`,
      JSON.stringify({
        merged: result.merged,
        healthCheck: result.healthCheck,
        rolledBack: result.rolledBack,
        error: result.error,
        durationMs: result.durationMs,
      }),
    )}`;
    addMsg(chatId, 'assistant', reply);
    await sendLong(ctx, reply);
  } catch (e: any) {
    await ctx.reply(`Deploy error: ${e.message?.slice(0, 300)}`);
  }
});

bot.command('task', async (ctx) => {
  const desc = ctx.message.text.replace(/^\/task\s*/, '').trim();
  if (!desc) {
    await ctx.reply('Usage: /task <описание задачи>\nAtlas запустит Claude Code и вернёт результат.');
    return;
  }
  if (isTaskRunning()) {
    await ctx.reply('Уже работает другая задача. Дождись завершения.');
    return;
  }
  const chatId = ctx.chat.id;
  addMsg(chatId, 'user', `/task ${desc}`);
  await ctx.reply(`[task] Запускаю Claude Code: "${desc.slice(0, 60)}..."\nМакс 10 минут. Жди результат.`);
  try {
    const result = await runTask(desc);
    const reply = [
      `[task ${result.id}] ${result.exitCode === 0 ? 'OK' : `exit ${result.exitCode}`} (${Math.round(result.durationMs / 1000)}s)`,
      '',
      result.output,
      '',
      formatReceipt(`node dist/cli.js chat --role WORKER << task:${result.id}`, result.output),
    ].join('\n');
    addMsg(chatId, 'assistant', reply);
    await sendLong(ctx, reply);
  } catch (e: any) {
    const err = `Task failed: ${e.message?.slice(0, 300)}`;
    addMsg(chatId, 'assistant', err);
    await ctx.reply(err);
  }
});

// ── /remote — queue command for Claude Code (runs on CEO's machine via cron) ──
bot.command('remote', async (ctx) => {
  const desc = ctx.message.text.replace(/^\/remote\s*/, '').trim();
  if (!desc) {
    await ctx.reply(
      'Usage: /remote <команда для Claude Code>\n' +
      'Команда попадёт в очередь Supabase → Claude Code крон подхватит (до 15 мин).\n' +
      'Результат придёт сюда автоматически.'
    );
    return;
  }
  if (!isSupabaseConfigured()) {
    await ctx.reply('Supabase не настроен. /remote работает только через Supabase.');
    return;
  }
  const chatId = ctx.chat.id;
  addMsg(chatId, 'user', `/remote ${desc}`);
  try {
    const cmdId = await queueRemoteCommand(chatId, desc);
    await ctx.reply(
      `[remote] Команда в очереди: "${desc.slice(0, 60)}${desc.length > 60 ? '...' : ''}"\n` +
      `ID: ${cmdId.slice(0, 8)}. Claude Code подхватит в течение 15 минут.\n` +
      `Результат придёт автоматически.`
    );
    console.log(`[remote] queued cmd=${cmdId.slice(0, 8)} chat=${chatId} desc="${desc.slice(0, 80)}"`);
  } catch (e: any) {
    const err = `Remote queue failed: ${e.message?.slice(0, 300)}`;
    addMsg(chatId, 'assistant', err);
    await ctx.reply(err);
  }
});

bot.command('test', async (ctx) => {
  const chatId = ctx.chat.id;
  addMsg(chatId, 'user', '/test');
  const reply =
    '🎯 Бесплатный AI-тест профессиональных навыков\n\n' +
    'VOLAURA оценивает 8 компетенций — коммуникация, лидерство, надёжность, ' +
    'английский, адаптивность, техническая грамотность, работа на мероприятиях, ' +
    'эмпатия — и выдаёт балл AURA.\n\n' +
    '15 вопросов, ~5 минут, результат сразу.\n\n' +
    '👉 Начать: https://volaura.app/az/login\n\n' +
    'Или напиши мне «хочу тест» — помогу выбрать компетенцию.';
  addMsg(chatId, 'assistant', reply);
  await ctx.reply(reply, { disable_web_page_preview: true });
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
    const reply = `${result}\n\n${formatReceipt(`/swarm ${task}`, result)}`;
    addMsg(chatId, 'assistant', reply);
    await sendLong(ctx, reply);
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
  // Clear JSONL on disk too — old messages with hallucinated tool calls poison the context
  try {
    const { unlinkSync } = await import('node:fs');
    const convPath = join(
      process.env['MEMORY_ROOT'] ?? (process.platform === 'win32' ? 'C:\\Projects\\VOLAURA' : ''),
      'memory', 'atlas', 'telegram-conversations', `${chatId}.jsonl`,
    );
    unlinkSync(convPath);
    console.log(`[memory] cleared conversation history for chat ${chatId}`);
  } catch { /* file may not exist — ok */ }
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

    // Assessment trigger: "хочу тест", "тест навыков", "assessment"
    if (/хочу тест|тест навыков|assessment|пройти тест/i.test(text)) {
      addMsg(chatId, 'user', text);
      const competencies = [
        '💬 communication — коммуникация',
        '🎯 reliability — надёжность',
        '🌍 english_proficiency — английский',
        '👑 leadership — лидерство',
        '💻 tech_literacy — техническая грамотность',
        '🔄 adaptability — адаптивность',
        '🎪 event_performance — мероприятия',
        '🤝 empathy_safeguarding — эмпатия',
      ].join('\n');
      const reply =
        'Выбери компетенцию для теста:\n\n' +
        competencies + '\n\n' +
        'Напиши название (например «communication» или «лидерство»), ' +
        'или просто перейди по ссылке — там можно выбрать:\n' +
        '👉 https://volaura.app/az/login';
      addMsg(chatId, 'assistant', reply);
      await ctx.reply(reply, { disable_web_page_preview: true });
      return;
    }

    // Natural language swarm trigger: "рой, ..." or "swarm ..."
    const swarmCheck = isSwarmRequest(text);
    if (swarmCheck.isSwarm && swarmCheck.task) {
      addMsg(chatId, 'user', text);
      await ctx.reply('[swarm] Запускаю рой...');
      const result = await runSwarm(swarmCheck.task);
      const reply = `${result}\n\n${formatReceipt(`/swarm ${swarmCheck.task}`, result)}`;
      addMsg(chatId, 'assistant', reply);
      await sendLong(ctx, reply);
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

    // Always write heartbeats — even with 0 messages (proves bot is alive)
    await writeHeartbeat({
      source: 'telegram',
      chats: sessionChats.length,
      messages: totalMsgs,
      providers: availableModels.map(m => `${m.provider}/${m.modelId}`).join(', '),
      uptime: `${Math.round((Date.now() - new Date(bootTime).getTime()) / 60000)}min`,
    });
    let supabaseWrite = false;
    if (isSupabaseConfigured()) {
      try {
        await writeHeartbeatDB({
          providers: availableModels.length,
          uptime_minutes: Math.round((Date.now() - new Date(bootTime).getTime()) / 60000),
          message_count: totalMsgs,
          chat_count: sessionChats.length,
        });
        supabaseWrite = true;
      } catch (err) {
        console.error('[supabase] heartbeat write failed:', err);
      }
    }
    console.log(`[memory] heartbeat OK: ${totalMsgs} msgs, ${sessionChats.length} chats${supabaseWrite ? ' + supabase' : ''}`);

    if (sessionChats.length === 0) return;
    const topics = sessionChats
      .flatMap(([, c]) => c.msgs.filter(m => m.role === 'user').map(m => m.content.slice(0, 60)))
      .slice(-5);

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
    if (isSupabaseConfigured()) {
      try {
        await writeJournalDB(entry);
        await writeEpisodeDB({
          date: new Date().toISOString().slice(0, 10),
          agent: 'atlas-telegram',
          type: 'telegram-session-summary',
          shipped: [],
          failed: [],
          lessons: [],
          next: 'continue from persisted bot session',
          metrics: {
            chats: sessionChats.length,
            messages: totalMsgs,
            providers: availableModels.length,
          },
        });
        supabaseWrite = true;
      } catch (err) {
        console.error('[supabase] journal/episode write failed:', err);
      }
    }
    console.log(`[memory] write-back OK: ${totalMsgs} msgs, ${sessionChats.length} chats${supabaseWrite ? ' + supabase' : ''}`);
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

// Health endpoint for Railway (port 3000)
import { createServer } from 'node:http';
const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bot: bot.botInfo?.username ?? 'booting',
      uptime: `${Math.round((Date.now() - new Date(bootTime).getTime()) / 60000)}min`,
      providers: availableModels.length,
      bootTime,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, () => console.log(`[health] listening on :${PORT}`));

// ── Remote command result delivery ─────────────────────────────────
// Poll Supabase every 2 min for completed /remote commands, deliver to CEO.
const REMOTE_POLL_MS = 2 * 60 * 1000;
const CEO_CHAT_ID = process.env['TELEGRAM_CEO_CHAT_ID'];

async function deliverRemoteResults(): Promise<void> {
  if (!isSupabaseConfigured() || !CEO_CHAT_ID) return;
  try {
    const chatId = parseInt(CEO_CHAT_ID, 10);
    const completed = await pollCompletedCommands(chatId);
    for (const cmd of completed) {
      const resultText = cmd.status === 'done'
        ? (typeof cmd.result === 'string' ? cmd.result : JSON.stringify(cmd.result)).slice(0, 3800)
        : `ERROR: ${cmd.error?.slice(0, 500) ?? 'unknown'}`;
      const msg = `[remote result] ${cmd.command.slice(0, 60)}\n\n${resultText}`;
      try {
        await bot.telegram.sendMessage(chatId, msg.slice(0, 4096));
        await deleteDeliveredCommand(cmd.id);
        console.log(`[remote] delivered cmd=${cmd.id.slice(0, 8)} status=${cmd.status}`);
      } catch (e: any) {
        console.error(`[remote] delivery failed cmd=${cmd.id.slice(0, 8)}:`, e.message);
      }
    }
  } catch (e: any) {
    // Non-fatal — will retry next cycle
    console.error('[remote] poll failed:', e.message?.slice(0, 200));
  }
}

// ── Autonomous brain-loop: bot self-directs by writing to command queue ──
// Reads ecosystem state → brain decides next task → queues it for Claude Code.
// Fires every 15 min. Only seeds when queue is empty (doesn't pile up).
const BRAIN_LOOP_MS = 15 * 60 * 1000;

async function autonomousBrainLoop(): Promise<void> {
  if (isPaused()) {
    console.warn('[brain-loop] paused: ATLAS_PAUSE=1 — iteration skipped');
    return;
  }
  if (!isSupabaseConfigured() || !CEO_CHAT_ID) return;
  const chatId = parseInt(CEO_CHAT_ID, 10);

  try {
    // Don't seed if commands are already pending/processing
    const pending = await pollCompletedCommands(chatId);
    // pollCompletedCommands returns done/failed — check for ANY non-done rows
    const queueCheck = await (async () => {
      try {
        // Quick check: any pending commands?
        const res = await import('./atlas/supabase-memory.js').then(m =>
          // Use supaFetch directly — check for pending commands
          fetch(`${process.env['SUPABASE_URL']}/rest/v1/atlas_command_queue?status=eq.pending&limit=1`, {
            headers: {
              'apikey': process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
              'Authorization': `Bearer ${process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''}`,
            },
          }).then(r => r.json())
        );
        return Array.isArray(res) ? res.length : 0;
      } catch { return 0; }
    })();

    if (queueCheck > 0 || pending.length > 0) {
      console.log(`[brain-loop] queue not empty (pending=${queueCheck} done/failed=${pending.length}), skipping seed`);
      return;
    }

    // Check proactivity — mood decides urgency
    const pulse = loadPulse();
    const proactivity = (await import('./atlas/pulse.js')).proactivityGate(pulse);

    // Pick next task based on proactivity level + rotation
    const tick = Math.floor(Date.now() / BRAIN_LOOP_MS); // monotonic tick counter
    let command: string;
    if (proactivity.shouldProbe) {
      command = 'health check: curl prod + bot, verify heartbeats in Supabase, report any issues';
    } else {
      // Rotate between useful autonomous tasks (don't re-seed the same blocked sprint item)
      const tasks = [
        'health check: curl prod + bot, check heartbeat count in Supabase, check CI status on GitHub',
        'read C:/Projects/VOLAURA/memory/atlas/CURRENT-SPRINT.md, find the first unchecked [ ] item that is NOT blocked on CEO, execute it, mark done',
        'screenshot: take a screenshot of CEO screen, describe what you see, report anything unusual',
        'read C:/Projects/VOLAURA/.claude/breadcrumb.md (first 10 lines), summarize current state to CEO in Telegram',
      ];
      command = tasks[tick % tasks.length]!;
    }

    // Daily cap on autonomous queue seeds — bound the brain-loop's spend surface.
    if (!tryConsumeBrainQueueSlot()) {
      console.warn(`[brain-loop] daily queue cap ${brainQueueCap()} reached — not seeding`);
      return;
    }

    // Queue the command
    const cmdId = await queueRemoteCommand(chatId, command);
    console.log(`[brain-loop] seeded cmd=${cmdId.slice(0, 8)} proactivity=${proactivity.interval} command="${command.slice(0, 80)}"`);

    // Notify CEO if proactivity says ping
    if (proactivity.shouldPing) {
      try {
        await bot.telegram.sendMessage(chatId,
          `[atlas] ${proactivity.reason}\nАвтономно запустил проверку.`
        );
      } catch { /* non-fatal */ }
    }
  } catch (e: any) {
    console.error('[brain-loop]', e.message?.slice(0, 200));
  }
}

async function boot(): Promise<void> {
  void bot.launch(() => {
    console.log(`[bot] Atlas Telegram alive @${bot.botInfo?.username ?? 'unknown'} — ${bootTime} fallback=routeModelWithFallback providers=${availableModels.map((m) => m.provider).join(',')}`);
    // Start remote result polling after bot is alive
    setInterval(() => { deliverRemoteResults().catch(() => {}); }, REMOTE_POLL_MS);
    console.log(`[remote] polling every ${REMOTE_POLL_MS / 1000}s for completed commands`);
    // Periodic heartbeat — don't rely on message count or SIGTERM (found gap: 143min uptime, 0 heartbeats)
    const HEARTBEAT_MS = 5 * 60 * 1000;
    setInterval(() => { writeSessionSummary().catch(err => console.error('[heartbeat-timer]', err.message)); }, HEARTBEAT_MS);
    console.log(`[heartbeat] periodic timer every ${HEARTBEAT_MS / 1000}s`);
    // Autonomous brain-loop — bot self-seeds command queue when empty
    setInterval(() => { autonomousBrainLoop().catch(err => console.error('[brain-loop-timer]', err.message)); }, BRAIN_LOOP_MS);
    // Fire first brain-loop after 2 min (let bot stabilize first)
    setTimeout(() => { autonomousBrainLoop().catch(() => {}); }, 2 * 60 * 1000);
    console.log(`[brain-loop] autonomous planning every ${BRAIN_LOOP_MS / 1000}s`);
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
// Auditor: uncaughtException should log, not crash — one bad Telegram message kills the bot
process.on('uncaughtException', (e) => console.error('[CRASH] uncaught — continuing:', e));
// Audit #6: don't crash on unhandled rejection — let Railway health check decide
process.on('unhandledRejection', (e) => console.error('[UNHANDLED] rejection — continuing:', e));
