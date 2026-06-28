/**
 * Supabase memory adapter — replaces file-based JSONL conversation store.
 * Tables: bot_sessions, bot_messages, bot_heartbeats (created 2026-06-27).
 *
 * Falls back to file-based store if SUPABASE_URL not set (local dev).
 */

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

export function isSupabaseConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

async function supaFetch(path: string, options: RequestInit = {}): Promise<any> {
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

// ── Emotional Memory Recall (ZenBrain decay) ──

export async function recallMemories(limit = 10, category?: string): Promise<Array<{
  category: string; content: string; emotional_intensity: number; decay_score: number;
}>> {
  const params = new URLSearchParams();
  params.set('p_limit', String(limit));
  if (category) params.set('p_category', category);

  return supaFetch(`rpc/recall_atlas_memories?${params}`, {
    method: 'POST',
    body: JSON.stringify({ p_limit: limit, ...(category ? { p_category: category } : {}) }),
  }).then((rows: any[]) => rows?.map(r => ({
    category: r.category,
    content: r.content,
    emotional_intensity: r.emotional_intensity,
    decay_score: r.decay_score,
  })) ?? []);
}

export async function saveMemory(category: string, content: string, emotionalIntensity: number, sourceMessage?: string): Promise<void> {
  await supaFetch('atlas_learnings', {
    method: 'POST',
    body: JSON.stringify({
      category,
      content,
      emotional_intensity: emotionalIntensity,
      source_message: sourceMessage,
    }),
  });
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
