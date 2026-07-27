/**
 * Supabase memory adapter — replaces file-based JSONL conversation store.
 * Tables: bot_sessions, bot_messages, bot_heartbeats (created 2026-06-27).
 *
 * Falls back to file-based store if SUPABASE_URL not set (local dev).
 */

function supabaseUrl(): string {
  return process.env['SUPABASE_URL'] ?? '';
}

function supabaseKey(): string {
  return process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
}

export function isSupabaseConfigured(): boolean {
  return !!(supabaseUrl() && supabaseKey());
}

async function supaFetch(path: string, options: RequestInit = {}): Promise<any> {
  const SUPABASE_URL = supabaseUrl();
  const SUPABASE_KEY = supabaseKey();
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase not configured');
  }

  // sb_secret_... keys use apikey header only (not a JWT, can't be Bearer).
  // Legacy eyJhbG... JWTs work as both apikey + Bearer.
  const isLegacyJWT = SUPABASE_KEY.startsWith('eyJ');
  const baseHeaders: Record<string, string> = {
    'apikey': SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': options.method === 'POST' ? 'return=representation' : 'return=minimal',
  };
  if (isLegacyJWT) {
    baseHeaders['Authorization'] = `Bearer ${SUPABASE_KEY}`;
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...baseHeaders, ...options.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Sessions ──

export async function createSession(chatId: number): Promise<string> {
  const [row] = await supaFetch('bot_sessions', {
    method: 'POST',
    body: JSON.stringify({ chat_id: chatId }),
  });
  return row.id;
}

export async function updateSession(sessionId: string, data: {
  message_count?: number;
  emotional_state?: Record<string, unknown>;
  provider_used?: string;
  summary?: string;
}): Promise<void> {
  await supaFetch(`bot_sessions?id=eq.${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...data, last_message_at: new Date().toISOString() }),
  });
}

export async function getLatestSession(chatId: number): Promise<any | null> {
  const rows = await supaFetch(
    `bot_sessions?chat_id=eq.${chatId}&order=created_at.desc&limit=1`
  );
  return rows?.[0] ?? null;
}

// ── Messages ──

export async function saveMessage(sessionId: string, chatId: number, msg: {
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  model?: string;
  emotional_read?: Record<string, unknown>;
}): Promise<void> {
  await supaFetch('bot_messages', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      chat_id: chatId,
      ...msg,
    }),
  });
}

export async function loadMessages(chatId: number, limit = 20): Promise<Array<{
  role: string; content: string; created_at: string;
}>> {
  return supaFetch(
    `bot_messages?chat_id=eq.${chatId}&order=created_at.desc&limit=${limit}&select=role,content,created_at`
  ).then((rows: any[]) => rows?.reverse() ?? []);
}

// ── Command Queue (Atlas→Claude Code bridge) ──
// Bot writes commands, Claude Code cron reads+executes, bot polls results.

export async function queueRemoteCommand(chatId: number, command: string): Promise<string> {
  const key = `tg-${chatId}-${Date.now().toString(36)}`;
  const [row] = await supaFetch('atlas_command_queue', {
    method: 'POST',
    body: JSON.stringify({
      idempotency_key: key,
      source: 'telegram',
      chat_id: chatId,
      command,
    }),
    headers: { 'Prefer': 'return=representation' },
  });
  return row.id;
}

export async function pollCompletedCommands(chatId: number): Promise<Array<{
  id: string; command: string; status: string; result: any; error: string | null;
}>> {
  return supaFetch(
    `atlas_command_queue?chat_id=eq.${chatId}&status=in.(done,failed)&select=id,command,status,result,error&order=created_at.desc&limit=5`
  ).then((rows: any[]) => rows ?? []);
}

export async function deleteDeliveredCommand(id: string): Promise<void> {
  await supaFetch(`atlas_command_queue?id=eq.${id}`, { method: 'DELETE' });
}

/**
 * Read-only operational peek at the most recent queue rows, ANY status —
 * for diagnosing the nerve (L2), never for the runner's own claim path.
 * Command text truncated to 80 chars; never returns secret-shaped fields.
 */
export async function peekQueue(limit = 10): Promise<Array<{
  id: string; status: string; attempts: number | null; commandPreview: string; created_at: string;
}>> {
  const rows = await supaFetch(
    `atlas_command_queue?select=id,status,attempts,command,created_at&order=created_at.desc&limit=${limit}`
  );
  return (rows ?? []).map((r: any) => ({
    id: r.id,
    status: r.status,
    attempts: r.attempts ?? null,
    commandPreview: typeof r.command === 'string' ? r.command.slice(0, 80) : `[${typeof r.command}]`,
    created_at: r.created_at,
  }));
}

// ── Consumer-side: claim + complete (Claude Code bridge) ──
// Uses RPC for atomic FOR UPDATE SKIP LOCKED claim — REST can't do row-locking.

/**
 * Atomically claim the next pending command. Returns null if queue empty.
 * Uses FOR UPDATE SKIP LOCKED so multiple consumers never double-pick.
 */
export async function claimNextCommand(workerId: string): Promise<{
  id: string; command: string; payload: unknown; chat_id: number; priority: number;
} | null> {
  const rows = await supaFetch('rpc/claim_next_command', {
    method: 'POST',
    body: JSON.stringify({ p_worker_id: workerId }),
  });
  // The RPC's PostgREST shape varies: a SETOF-style RPC returns an array
  // (possibly empty when there's nothing to claim), some RPC return
  // conventions hand back a single object directly instead. The old
  // `rows?.[0] ?? rows ?? null` broke on the empty-queue case: `[][0]` is
  // undefined, so it fell through to `?? rows`, returning the EMPTY ARRAY
  // ITSELF as the "claimed command" — and `![]` is false in JS (arrays are
  // truthy), so callers' `if (!claimed) return idle` never fired. Found
  // live 2026-07-27 via atlas-runner's first real ticks against an empty
  // queue: every tick reported a "malformed command" failure instead of
  // idle. Explicit array-vs-object handling closes this for good.
  if (Array.isArray(rows)) {
    return rows.length > 0 ? rows[0] : null;
  }
  return rows ?? null;
}

/** Mark a claimed command as done with result. */
export async function completeCommand(id: string, result: unknown): Promise<void> {
  await supaFetch(`atlas_command_queue?id=eq.${id}&status=eq.processing`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'done',
      result: typeof result === 'string' ? { output: result } : result,
      completed_at: new Date().toISOString(),
    }),
  });
}

/** Mark a claimed command as failed with error message. */
export async function failCommand(id: string, error: string): Promise<void> {
  await supaFetch(`atlas_command_queue?id=eq.${id}&status=eq.processing`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'failed',
      error: error.slice(0, 2000),
      completed_at: new Date().toISOString(),
    }),
  });
}

/**
 * Sweep stale processing commands (crashed consumer). Resets to pending if
 * under max_attempts, otherwise marks dead.
 */
export async function sweepStaleCommands(timeoutMinutes = 30): Promise<number> {
  const rows = await supaFetch('rpc/sweep_stale_commands', {
    method: 'POST',
    body: JSON.stringify({ p_timeout_minutes: timeoutMinutes }),
  });
  return rows?.swept ?? 0;
}

// ── Emotional Memory Recall (ZenBrain decay) ──

export async function recallMemories(limit = 10, category?: string): Promise<Array<{
  category: string; content: string; emotional_intensity: number; decay_score: number;
}>> {
  // RPC parameters go ONLY in the POST body. Appending them as URL query params
  // causes PostgREST to interpret them as row filters → "failed to parse filter (5)".
  const rows: any[] = await supaFetch('rpc/recall_atlas_memories', {
    method: 'POST',
    body: JSON.stringify({ p_limit: limit, ...(category ? { p_category: category } : {}) }),
  });

  const mapped = rows?.map(r => ({
    category: r.category,
    content: r.content,
    emotional_intensity: r.emotional_intensity,
    decay_score: r.decay_score,
  })) ?? [];

  // Write-back: atomically increment recall_count + stamp last_recalled_at for all
  // surfaced rows. Fire-and-forget — never blocks the caller, never throws.
  const ids: string[] = (rows ?? []).map((r: any) => r.id).filter(Boolean);
  if (ids.length > 0) {
    supaFetch('rpc/bump_recall_count', {
      method: 'POST',
      body: JSON.stringify({ p_ids: ids }),
    }).catch((e: unknown) => {
      console.warn(`[supabase-memory] recallMemories write-back failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  return mapped;
}

export async function saveMemory(
  category: string,
  content: string,
  emotionalIntensity: number,
  sourceMessage?: string,
  decayMultiplier?: number,
): Promise<void> {
  // decay_multiplier is the ZenBrain half-life scaler (emotion.ts:175). Default it from
  // intensity when the caller doesn't pass the real read, so the row is still rankable
  // by recall_atlas_memories (db/migrations/001_emotional_memory.sql).
  const decay = decayMultiplier ?? 1.0 + emotionalIntensity * 2.0;
  await supaFetch('atlas_learnings', {
    method: 'POST',
    body: JSON.stringify({
      category,
      content,
      emotional_intensity: emotionalIntensity,
      decay_multiplier: decay,
      source_message: sourceMessage,
    }),
  });
}

// ── Emotional Memory Write (compound loop) ──
// Atlas WRITES emotional memories on meaningful turns so recall can compound from its
// own operation. Gated on intensity so trivia doesn't flood the store, deduped against
// recent identical content, and fully non-blocking: any failure is logged, never thrown
// (a lost memory must never break a reply). Pairs with recallMemories()/emotion.ts.

/** Minimum ZenBrain intensity (0-5) for a turn to be worth remembering. */
export const EMOTIONAL_MEMORY_MIN_INTENSITY = 2;

// Tiny in-process dedup: skip re-saving the exact same content we just saved.
const recentSaves: string[] = [];
const RECENT_SAVE_MAX = 32;

export interface EmotionalMemoryInput {
  category: string;
  content: string;
  intensity: number; // REAL emotion.analyzeWindow(...).intensity — never a constant
  decayMultiplier?: number; // REAL emotion read decayMultiplier (1.0 + intensity*2.0)
  sourceMessage?: string;
  minIntensity?: number; // override the gate (tests)
}

/**
 * Save an emotional memory IF the turn cleared the intensity gate and isn't a dup.
 * Returns whether a write was attempted. Never throws.
 */
export async function saveEmotionalMemory(input: EmotionalMemoryInput): Promise<boolean> {
  const threshold = input.minIntensity ?? EMOTIONAL_MEMORY_MIN_INTENSITY;
  if (!Number.isFinite(input.intensity) || input.intensity < threshold) {
    return false; // trivial exchange — don't remember it
  }
  const dedupKey = `${input.category}::${input.content}`;
  if (recentSaves.includes(dedupKey)) {
    return false; // obvious repeat — already remembered
  }
  try {
    await saveMemory(
      input.category,
      input.content,
      input.intensity,
      input.sourceMessage,
      input.decayMultiplier,
    );
    recentSaves.push(dedupKey);
    if (recentSaves.length > RECENT_SAVE_MAX) recentSaves.shift();
    return true;
  } catch (e) {
    // Non-blocking: a lost memory must never break the reply path.
    console.warn(`[emotional-memory] save failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function writeJournalDB(entry: string, source = 'telegram-session-summary'): Promise<void> {
  await saveMemory(
    'project_context',
    `[journal:${source}]\n${entry}`,
    1,
    source,
  );
}

export async function writeEpisodeDB(episode: Record<string, unknown>, source = 'telegram-session-summary'): Promise<void> {
  await saveMemory(
    'project_context',
    `[episode:${source}]\n${JSON.stringify(episode)}`,
    1,
    source,
  );
}

// ── Heartbeats ──

export async function writeHeartbeatDB(data: {
  providers: number;
  uptime_minutes: number;
  message_count: number;
  chat_count: number;
}): Promise<void> {
  await supaFetch('bot_heartbeats', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Durable read-back (Railway anonymous-volume mitigation) ──
// journal.md/heartbeat.md live on the local Docker filesystem, which Railway wipes on
// every redeploy (no persistent volume configured — MASTER-PLAN Rank 3). The rows are
// already written above via writeJournalDB/writeHeartbeatDB; these two read them BACK
// so memory-manager.ts can hydrate wake/brain context from Supabase when the local
// vault is missing or empty. Both are strictly non-fatal — any error/empty/unconfigured
// state resolves to the "nothing to show" value so a Supabase hiccup never breaks boot.

/** Read the most recent journal entries written by writeJournalDB, newest-last. */
export async function loadRecentJournalDB(limit = 3): Promise<string> {
  if (!isSupabaseConfigured()) return '';
  try {
    const rows = await supaFetch(
      `atlas_learnings?content=like.%5Bjournal:*&order=created_at.desc&limit=${limit}&select=content,created_at`
    );
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const entries = rows
      .map((r: any) => String(r.content ?? '').replace(/^\[journal:[^\]]*\]\n/, ''))
      .filter((s: string) => s.trim().length > 0)
      .reverse(); // rows arrive newest-first (desc); caller wants newest-last
    return entries.join('\n---\n');
  } catch (e) {
    console.warn(`[supabase-memory] loadRecentJournalDB failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

/** Read the latest heartbeat row written by writeHeartbeatDB, formatted as short markdown. */
export async function loadLatestHeartbeatDB(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const rows = await supaFetch('bot_heartbeats?order=created_at.desc&limit=1');
    const row = rows?.[0];
    if (!row) return null;
    return `Updated (DB): ${row.created_at}\nproviders: ${row.providers} | uptime_min: ${row.uptime_minutes} | messages: ${row.message_count} | chats: ${row.chat_count}`;
  } catch (e) {
    console.warn(`[supabase-memory] loadLatestHeartbeatDB failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
