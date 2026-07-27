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
import { isSupabaseConfigured, createSession, saveMessage, loadMessages, writeHeartbeatDB, writeJournalDB, writeEpisodeDB, updateSession, getLatestSession, pollCompletedCommands, deleteDeliveredCommand, saveEmotionalMemory } from './atlas/supabase-memory.js';
import { formatReceipt } from './atlas/receipt.js';
import { launchWithRetry } from './atlas/resilient-launch.js';
import { startInProcWorker, inProcWorkerEnabled } from './atlas/queue-worker.js';
import { composeMorningBriefing, scheduleMorningBriefing } from './atlas/briefing.js';
import { readOperatorState } from './atlas/control-plane.js';
import { readLastReport } from './atlas/cron.js';
import { listAvailableModels, routeModelWithFallback } from './model-router.js';
import { recordSpendFromResult } from './atlas/spend-tracker.js';
import { enforceSpendPolicy, isPaused } from './atlas/spend-policy.js';
import { buildStatusReport } from './atlas/status-report.js';
import { notifyCeoResult } from './atlas/notify.js';
import { renderHelp } from './atlas/commands.js';
import { analyzeWindow, readEmotion, buildEmotionDirectiveLine } from './atlas/emotion.js';
import { checkEmotionalSafety, logToneShift } from './atlas/emotional-safety.js';
import { loadPulse, savePulse, processEvent } from './atlas/pulse.js';
import { runOperatorActionLane } from './operator/action-lane.js';
import { classifyIntent, routeFreeformAction, defaultActionRouterDeps, actionResultToReply } from './atlas/action-router.js';
import { runSwarm } from './swarm.js';
import { getMemoryRoot } from './atlas/path-util.js';
import { isAuthorizedChat } from './atlas/telegram-auth.js';

// Re-exported so telegram.ts is still the canonical place callers look for it —
// the actual pure logic lives in atlas/telegram-auth.ts (see that file for why:
// telegram.ts boots a live bot at import time, so it can't be unit-imported).
export { isAuthorizedChat };

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

// ── Inbound auth gate — CEO-only ────────────────────────────────────
// TELEGRAM_CEO_CHAT_ID already gates OUTBOUND sends (see CEO_CHAT_ID ~line 729).
// This gates INBOUND updates: without it, every bot.command()/bot.on('text')
// handler below served anyone who found the bot — including /swarm → shellTool,
// a direct path to secret exfil. Fail-closed: unset id or non-matching sender
// never reaches a handler.
const ALLOWED_CEO_ID = process.env['TELEGRAM_CEO_CHAT_ID']
  ? Number.parseInt(process.env['TELEGRAM_CEO_CHAT_ID'], 10)
  : NaN;

bot.use(async (ctx, next) => {
  try {
    const senderId = ctx.chat?.id ?? ctx.from?.id;
    if (Number.isNaN(ALLOWED_CEO_ID)) {
      console.error('[auth] FATAL: TELEGRAM_CEO_CHAT_ID unset — refusing ALL inbound messages (owner-less tool-equipped bot)');
      return;
    }
    if (isAuthorizedChat(senderId, ALLOWED_CEO_ID)) {
      await next();
      return;
    }
    console.warn('[auth] dropped message from unauthorized chat', senderId);
    return;
  } catch (e) {
    console.error('[auth] middleware exception — dropping message (fail-closed):', e);
    return;
  }
});

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
// [removed 2026-07-10] ungoverned ACTION_PATTERNS->execSync path deleted (board P0); real shell goes through governed shellTool only.

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

  // Phase 4.3: freeform action-router — classify intent, route safe actions
  // to exec-graph, gate red-lines. Wrapped so any throw falls through to brain reply.
  try {
    if (classifyIntent(text) === 'action') {
      const routerResult = await routeFreeformAction(text, defaultActionRouterDeps());
      const actionReply = actionResultToReply(routerResult);
      if (actionReply) {
        addMsg(chatId, 'assistant', actionReply);
        return actionReply;
      }
      // kind:'chat' → actionReply is null → fall through to normal brain reply
    }
  } catch (e) {
    console.error('[action-router] error, falling through to brain reply:', e);
  }

  const messages = buildMessages(chatId);
  console.log(`[in]  chat=${chatId} msg="${text.slice(0, 100)}"`);

  // Emotion layer: read CEO state over the last 2-3 user messages (05-emotional-states.md:59),
  // update Atlas's own Pulse, persist MOOD.md. Phase 2.8: LLM-first read via readEmotion()
  // (keyword fallback inside); directive injected into system prompt below.
  const userWindow = getConvo(chatId)
    .msgs.filter((m) => m.role === 'user')
    .slice(-3)
    .reverse()
    .map((m) => m.content);

  // Sync keyword read as safety baseline — readEmotion() upgrades it asynchronously.
  // If readEmotion throws even with its internal fallback, the reply still proceeds.
  let ceoRead = analyzeWindow(userWindow);
  try {
    ceoRead = await readEmotion(userWindow);
  } catch {
    // readEmotion already catches internally; outer guard keeps the reply path alive.
  }

  const pulse = processEvent(loadPulse(), 'ceo', 'user_feedback');
  savePulse(pulse.state, `telegram message, CEO read: ${ceoRead.state}`);
  console.log(
    `[emotion] chat=${chatId} ceo=${ceoRead.state}/${ceoRead.intensity} pulse-int=${pulse.intensity.toFixed(2)}${pulse.wouldBlock ? ' [would-block: log-only]' : ''}`,
  );

  const basePlan = await buildAtlasBrainPlan({ channel: 'telegram', recentUserMessages: userWindow });
  const system = basePlan.systemPrompt + '\n\n' + buildEmotionDirectiveLine(ceoRead);
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

  // Phase 3.5 emotional-safety audit — log-only, never blocks or rewrites.
  // Runs whenever emotion shifted tone (state !== 'neutral'), regardless of violations.
  if (ceoRead.state !== 'neutral') {
    const safetyCheck = checkEmotionalSafety(finalReply);
    if (safetyCheck.flagged) {
      console.warn(`[emotional-safety] chat=${chatId} state=${ceoRead.state} violations=${JSON.stringify(safetyCheck.violations)}`);
    }
    logToneShift({
      state: ceoRead.state,
      directive: ceoRead.directive,
      ts: new Date().toISOString(),
      ...(safetyCheck.flagged ? { violations: safetyCheck.violations } : {}),
    });
  }

  addMsg(chatId, 'assistant', finalReply);

  // Compound-memory loop: remember emotionally meaningful CEO turns using the REAL
  // ZenBrain read (ceoRead.intensity / ceoRead.decayMultiplier from emotion.ts — not a
  // constant). Gated + deduped + non-blocking inside saveEmotionalMemory; high-emotion
  // memories persist longer and feed the next wake via recallMemories().
  if (isSupabaseConfigured()) {
    void saveEmotionalMemory({
      category: `ceo_turn:${ceoRead.state}`,
      content: text.slice(0, 1000),
      intensity: ceoRead.intensity,
      decayMultiplier: ceoRead.decayMultiplier,
      sourceMessage: text.slice(0, 200),
    });
  }

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
  addMsg(chatId, 'user', '/status');
  try {
    // In-process status: health checks + today's spend + brain-loop queue + heartbeat.
    // No external script, no shell-out — reads the same live meters the bot runs on.
    let reply = buildStatusReport();

    // Exec-graph (EB-0) task state — the ONE task authority (src/exec-graph/README.md),
    // not an ad-hoc list. Lazy dynamic import (repo style, see src/cli.ts's `graph status`).
    // Own try/catch: exec-graph reads are already fail-safe (never throw — see README's
    // "Failure behavior") but this is belt-and-suspenders so a Railway read-only image
    // or any surprise here degrades to a one-line note instead of losing the whole /status.
    try {
      const { statusSummary, listTasks } = await import('./exec-graph/api.js');
      const { formatStatusMessage } = await import('./exec-graph/brief.js');
      reply += `\n\n${formatStatusMessage(statusSummary(), listTasks())}`;
    } catch (execGraphErr) {
      reply += '\n\nExec-graph: не смог прочитать состояние задач.';
      console.error('[status error][exec-graph]', execGraphErr);
    }

    addMsg(chatId, 'assistant', reply);
    await ctx.reply(reply);
  } catch (e) {
    const err = `Не смог собрать статус, причина: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}. Проверь логи бота.`;
    addMsg(chatId, 'assistant', err);
    await ctx.reply(err);
    console.error('[status error]', e);
  }
});

// ── /brief — CEO board read (L1 ladder) ────────────────────────────
// Read-only projection over exec-graph + drift signals. Pure formatters in
// src/atlas/cos/telegram-formatters.ts are unit-tested without a live bot.
// Any throw → honest error reply; never kills the bot process.
bot.command('brief', async (ctx) => {
  try {
    const { gatherCosFacts } = await import('./atlas/cos/facts.js');
    const { detectDrift } = await import('./atlas/cos/drift.js');
    const { composeCosBriefItems } = await import('./atlas/cos/brief.js');
    const { gatherLiveDriftInputs } = await import('./atlas/cos/gather.js');
    const { formatBriefForTelegram } = await import('./atlas/cos/telegram-formatters.js');

    const facts = gatherCosFacts();
    const drift = detectDrift(gatherLiveDriftInputs());
    const items = composeCosBriefItems(facts, drift);
    const reply = formatBriefForTelegram(items);
    await ctx.reply(reply);
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 200) : String(e);
    await ctx.reply(`Не смог прочитать борт: ${reason}`);
    console.error('[/brief error]', e);
  }
});

// ── /drift — drift/stale-signal findings only (L1 ladder) ──────────
bot.command('drift', async (ctx) => {
  try {
    const { detectDrift } = await import('./atlas/cos/drift.js');
    const { gatherLiveDriftInputs } = await import('./atlas/cos/gather.js');
    const { formatDriftForTelegram } = await import('./atlas/cos/telegram-formatters.js');

    const findings = detectDrift(gatherLiveDriftInputs());
    const reply = formatDriftForTelegram(findings);
    await ctx.reply(reply);
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 200) : String(e);
    await ctx.reply(`Не смог прочитать борт: ${reason}`);
    console.error('[/drift error]', e);
  }
});

// ── /tasks — active exec-graph tasks (L1 ladder) ───────────────────
// Shows only non-terminal tasks (not verified/closed/rejected).
// Never throws — "Граф пуст." on empty or unreadable graph.
bot.command('tasks', async (ctx) => {
  try {
    const { listTasks } = await import('./exec-graph/api.js');
    const { formatTasksForTelegram } = await import('./atlas/cos/telegram-formatters.js');

    const tasks = listTasks();
    const reply = formatTasksForTelegram(tasks);
    await ctx.reply(reply);
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 200) : String(e);
    await ctx.reply(`Не смог прочитать борт: ${reason}`);
    console.error('[/tasks error]', e);
  }
});

// /help — generated from the command registry (src/atlas/commands.ts), never
// hand-maintained. RU/EN by the user's Telegram language_code.
bot.command('help', async (ctx) => {
  const chatId = ctx.chat.id;
  addMsg(chatId, 'user', '/help');
  const reply = renderHelp(ctx.from?.language_code);
  addMsg(chatId, 'assistant', reply);
  await ctx.reply(reply);
});

bot.command('models', async (ctx) => {
  const models = listAvailableModels();
  const lines = models.map(m => `${m.provider}/${m.modelId} (tier ${m.costTier}, ${m.roles.join('/')})`);
  const reply = `Available models (${models.length}):\n${lines.join('\n')}`;
  await ctx.reply(reply);
});

// /pause — panic switch. Sets ATLAS_PAUSE=1 for THIS process (halts autonomy:
// brain-loop, swarm decompose, task-spawner). Process-local + instant, no redeploy.
// For a pause that survives a redeploy, set the Railway env var. See docs/PANIC.md.
// Already CEO-only via the inbound-auth middleware (telegram.ts top).
bot.command('pause', async (ctx) => {
  // Route through the control-plane state machine (M7 unification).
  // Also set ATLAS_PAUSE for process-local backward compat (spend-policy gate).
  process.env.ATLAS_PAUSE = '1';
  const result = applyControlCommand({ command: 'pause' }, 'telegram');
  const reply = `⏸ ${result.message}`;
  await ctx.reply(reply);
});

// /resume — lift the process-local pause AND transition control-plane to active.
// Reports any remaining hard overlays (env var on Railway, pause file).
bot.command('resume', async (ctx) => {
  process.env.ATLAS_PAUSE = '';
  const result = applyControlCommand({ command: 'resume' }, 'telegram');
  const reply = `▶️ ${result.message}`;
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
  if (isPaused()) {
    await ctx.reply('Emergency pause active: ATLAS_PAUSE=1');
    return;
  }
  if (!controlAllowsModelCalls()) {
    await ctx.reply(describeControlBlock());
    return;
  }
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
  const chatId = ctx.chat.id;
  addMsg(chatId, 'user', ctx.message.text);
  // [removed 2026-07-10] auto-queue to ungoverned external cron deleted (board P0).
  // Previously parsed desc, checked isSupabaseConfigured, and called
  // queueRemoteCommand(chatId, desc) here, writing into Supabase
  // atlas_command_queue for an off-repo CEO-machine cron to execute with zero
  // evidence-gate, shell classifier, or audit. Ingestion closed.
  const reply = '/remote отключён: неподконтрольный внешний исполнитель убран (board P0). Governed in-repo путь вернётся позже.';
  addMsg(chatId, 'assistant', reply);
  await ctx.reply(reply);
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
  await ctx.reply(reply, { link_preview_options: { is_disabled: true } });
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
      getMemoryRoot(),
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
      await ctx.reply(reply, { link_preview_options: { is_disabled: true } });
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
      const receipt = formatReceipt(`/remote ${cmd.command}`, resultText);
      const msg = `[remote result] ${cmd.command.slice(0, 60)}\n\n${resultText}\n\n${receipt}`;
      try {
        // M7: route through canonical notify chokepoint (quiet-hours aware).
        const outcome = await notifyCeoResult('remote-result', msg);
        if (outcome.result === 'SENT' || outcome.result === 'QUEUED') {
          await deleteDeliveredCommand(cmd.id);
        }
        console.log(`[remote] delivered cmd=${cmd.id.slice(0, 8)} status=${cmd.status} notify=${outcome.result}`);
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
  // [removed 2026-07-10] auto-queue to ungoverned external cron deleted (board P0).
  // This loop previously polled Supabase for an empty queue, picked a rotating
  // task (proactivity-gated), and called queueRemoteCommand(chatId, command) to
  // feed the off-repo CEO-machine cron with zero evidence-gate, shell
  // classifier, or audit — then told the CEO it had "autonomously" run a check,
  // which would now be false since nothing is queued. Left inert; a governed
  // in-repo replacement (queue-worker.ts style) can restore autonomy later.
  if (isPaused()) return;
  if (!isSupabaseConfigured() || !CEO_CHAT_ID) return;
}

// ── Morning briefing (08:45 Baku) ──────────────────────────────────
// Derives 3 clauses from operator state + last health report, appends
// today's in-memory spend, sends to CEO. Guarded on TELEGRAM_CEO_CHAT_ID.
async function sendMorningBriefing(): Promise<void> {
  if (!CEO_CHAT_ID) return;
  const chatId = parseInt(CEO_CHAT_ID, 10);
  if (!Number.isFinite(chatId)) return;

  // Night: last health report summary (falls back to a calm default).
  let night = 'бот работал стабильно, инцидентов не зафиксировано';
  try {
    const report = await readLastReport();
    if (report) {
      const firstLine = report.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
      if (firstLine) night = firstLine.replace(/^#+\s*/, '').slice(0, 200);
    }
  } catch { /* non-fatal */ }

  // Today + awaiting-CEO: operator state (next phase / pending run).
  let today = 'продолжаю по текущему плану';
  let awaitingCeo = 'ничего не блокирует — жду сигнала';
  try {
    const state = readOperatorState();
    if (state.phase?.next) today = `фаза «${String(state.phase.next).slice(0, 120)}»`;
    const lastRun = state.last_run;
    if (lastRun && lastRun.status && lastRun.status !== 'success') {
      awaitingCeo = `последний прогон ${lastRun.task_id ?? '?'} — ${lastRun.status}${lastRun.reason ? ` (${String(lastRun.reason).slice(0, 80)})` : ''}`;
    }
  } catch { /* non-fatal */ }

  let text = composeMorningBriefing({ night, today, awaitingCeo });

  // Exec-graph (EB-0) decision-framed section — the ONE task authority
  // (src/exec-graph/README.md), appended only when non-empty so a quiet
  // graph doesn't add a blank trailer to the briefing. Own try/catch, same
  // fail-safe posture as the exec-graph section in bot.command('status')
  // above: a broken read must degrade, never block the briefing send.
  try {
    const { statusSummary, listTasks } = await import('./exec-graph/api.js');
    const { formatMorningBriefSection } = await import('./exec-graph/brief.js');
    const execGraphSection = formatMorningBriefSection(statusSummary(), listTasks(), { now: new Date() });
    if (execGraphSection) text += `\n\n${execGraphSection}`;
  } catch (execGraphErr) {
    console.error('[briefing] exec-graph section failed:', execGraphErr);
  }

  try {
    // M7: route through canonical notify chokepoint (quiet-hours aware).
    const outcome = await notifyCeoResult('briefing', text);
    console.log(`[briefing] morning briefing notify=${outcome.result}`);
  } catch (e: any) {
    console.error('[briefing] send failed:', e?.message?.slice(0, 200));
  }
}

async function boot(): Promise<void> {
  const onLaunchCb = () => {
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
    // In-repo queue CONSUMER — OPT-IN ONLY (ATLAS_INPROC_WORKER=1). Closes the
    // external-consumer gap in docs/QUEUE-CONTRACT.md. Exactly one consumer may
    // be active: if this is on, the external CEO-machine consumer must be off.
    if (inProcWorkerEnabled()) {
      const WORKER_POLL_MS = 30 * 1000;
      startInProcWorker(WORKER_POLL_MS);
    } else {
      console.log('[queue-worker] in-proc worker OFF (external consumer expected)');
    }
    // Morning briefing at 08:45 Baku, then daily. Guarded on TELEGRAM_CEO_CHAT_ID inside.
    if (CEO_CHAT_ID) {
      scheduleMorningBriefing(() => sendMorningBriefing());
      console.log('[briefing] scheduled morning briefing for 08:45 Baku (daily)');
    } else {
      console.log('[briefing] skipped — TELEGRAM_CEO_CHAT_ID not set');
    }
  };

  // Telegraf invokes onLaunch right after getMe() succeeds — BEFORE
  // deleteWebhook/startPolling actually run (see telegraf/lib/telegraf.js
  // launch()). getMe() succeeds independent of any long-poll conflict, so on
  // a retried launch() (below) it would fire again on every attempt, not
  // just the one that actually starts polling — re-registering the
  // intervals/in-proc worker/briefing schedule above each time. Guard so the
  // body above runs at most once, without changing what it does.
  let onLaunchFired = false;
  const onLaunchOnce = () => {
    if (onLaunchFired) return;
    onLaunchFired = true;
    onLaunchCb();
  };

  // Railway zero-downtime deploys run the old + new container together
  // briefly, so the new container's launch() can hit Telegram 409 Conflict
  // while the old poller is still attached (see polling.js: 401/409 rethrow
  // out of launch()). Exiting on that (old behavior) killed the new
  // container before Railway's healthcheck ever saw it healthy, so the
  // deploy failed and the old container never got retired. Retry with
  // backoff instead — the /health server (below) stays up independently, so
  // Railway marks the new container healthy, retires the old one, and this
  // retry connects cleanly.
  const LAUNCH_MAX_TRIES = 120;
  const LAUNCH_RETRY_DELAY_MS = 5000;
  void launchWithRetry(
    () => bot.launch({ dropPendingUpdates: true }, onLaunchOnce),
    {
      maxTries: LAUNCH_MAX_TRIES,
      delayMs: LAUNCH_RETRY_DELAY_MS,
      onRetry: (attempt, err) => {
        console.warn(`[launch] conflict/err, retry ${attempt}/${LAUNCH_MAX_TRIES} in ${LAUNCH_RETRY_DELAY_MS / 1000}s`, err);
      },
    },
  ).catch((error) => fatal('[LAUNCH FAILED after retries]', error));
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
