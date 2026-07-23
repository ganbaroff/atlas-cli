/**
 * Atlas emotion — reads CEO's emotional state from a message (PAD model).
 *
 * Ported verbatim from C:/Projects/VOLAURA/scripts/atlas_emotional_engine.py
 * (CEO-authored vocabulary, lines 37-154). This is the DETERMINISTIC keyword core —
 * it is also the offline FALLBACK. The LLM-accurate primary path (freellmapi/gemini
 * with the OLLAMA_EMOTION_PROMPT) layers on top in the next step, because a keyword
 * matcher alone misfires (substring matching: 'бля' fires inside 'блять', 'ок' inside
 * 'около') and would feel dead as the sole reader. Keep this as the zero-dep fallback.
 *
 * PAD: valence -1..+1 (negative→positive), arousal 0..1 (calm→excited),
 *      dominance 0..1 (submissive→dominant).
 */
import { Agent } from '@mastra/core/agent';
import { routeModelWithFallback } from '../model-router.js';

export type EmotionState =
  | 'drive'
  | 'warm'
  | 'correcting'
  | 'exhausted'
  | 'analytical'
  | 'neutral';

export interface EmotionRead {
  valence: number;
  arousal: number;
  dominance: number;
  state: EmotionState;
  intensity: number; // ZenBrain 0-5 scale
  decayMultiplier: number; // 1.0 + intensity*2.0
  directive: string;
  matchedKeywords: number;
}

/**
 * CEO emotional vocabulary — mined from 18 memory/ceo/ files + 37 feedback files.
 * Each word → [valence, arousal, dominance]. Verbatim from atlas_emotional_engine.py:37-74.
 */
const CEO_VOCABULARY: Record<string, [number, number, number]> = {
  // Positive high-energy (drive state)
  'шикарно': [0.9, 0.8, 0.7],
  'круто': [0.8, 0.7, 0.6],
  'офигенно': [0.9, 0.9, 0.7],
  'молодец': [0.7, 0.5, 0.8],
  'правильно': [0.6, 0.3, 0.7],
  'заебись': [0.8, 0.8, 0.8],
  'красава': [0.8, 0.7, 0.7],
  '))))': [0.7, 0.8, 0.5],
  'миллионером': [0.9, 0.9, 0.9],

  // Negative corrective (teaching state)
  'блять': [-0.3, 0.7, 0.8],
  'бля': [-0.2, 0.6, 0.7],
  'опять': [-0.5, 0.5, 0.7],
  'заебал': [-0.6, 0.7, 0.8],
  'нахуя': [-0.5, 0.8, 0.9],
  'проебал': [-0.7, 0.6, 0.7],
  'бесит': [-0.6, 0.7, 0.8],
  'нахрен': [-0.4, 0.7, 0.8],

  // Negative low-energy (exhaustion state)
  'нууууу': [-0.3, 0.2, 0.3],
  'устал': [-0.4, 0.1, 0.2],
  'ну зачем': [-0.4, 0.3, 0.5],

  // Neutral analytical
  'давай': [0.1, 0.4, 0.6],
  'ок': [0.0, 0.2, 0.5],
  'дальше': [0.1, 0.4, 0.6],
  'проверь': [0.0, 0.4, 0.7],

  // Trust/commitment
  'друг': [0.7, 0.3, 0.5],
  'братишка': [0.8, 0.5, 0.5],
  'верю': [0.8, 0.3, 0.6],
  'обещаю': [0.7, 0.4, 0.7],
};

/**
 * Read CEO emotion from one message (keyword path). Substring match preserved from
 * the Python source for fidelity — short keys over-trigger by design; the LLM path
 * is the accurate primary, this is the deterministic fallback.
 */
export function analyzeMessage(message: string): EmotionRead {
  const msgLower = message.toLowerCase();

  let vSum = 0;
  let aSum = 0;
  let dSum = 0;
  let matches = 0;

  for (const key of Object.keys(CEO_VOCABULARY)) {
    if (msgLower.includes(key)) {
      const [v, a, d] = CEO_VOCABULARY[key];
      vSum += v;
      aSum += a;
      dSum += d;
      matches += 1;
    }
  }

  if (matches === 0) {
    return {
      valence: 0,
      arousal: 0.3,
      dominance: 0.5,
      state: 'neutral',
      intensity: 0,
      decayMultiplier: 1.0,
      directive: 'standard_response',
      matchedKeywords: 0,
    };
  }

  const v = vSum / matches;
  const a = aSum / matches;
  const d = dSum / matches;

  return finishRead(v, a, d, matches);
}

/**
 * Windowed read — «Check last 2-3 messages, NOT just the current one. State can flip
 * mid-conversation» (memory/ceo/05-emotional-states.md:59). Weights: current 0.6,
 * previous 0.3, the one before 0.1. Messages with zero vocabulary matches are skipped
 * (a neutral "ок" follow-up must not wash out a strong prior signal).
 */
export function analyzeWindow(messages: string[]): EmotionRead {
  const weights = [0.6, 0.3, 0.1];
  let vW = 0;
  let aW = 0;
  let dW = 0;
  let wSum = 0;
  let totalMatches = 0;

  messages.slice(0, 3).forEach((msg, i) => {
    const r = analyzeMessage(msg);
    if (r.matchedKeywords === 0) return;
    const w = weights[i] ?? 0.1;
    vW += r.valence * w;
    aW += r.arousal * w;
    dW += r.dominance * w;
    wSum += w;
    totalMatches += r.matchedKeywords;
  });

  if (wSum === 0) return analyzeMessage(messages[0] ?? '');
  return finishRead(vW / wSum, aW / wSum, dW / wSum, totalMatches);
}

function finishRead(v: number, a: number, d: number, matches: number): EmotionRead {
  // 5-state classifier — exact thresholds from atlas_emotional_engine.py:136-150.
  // KNOWN DEAD ZONE (preserved verbatim): v<-0.3 with 0.3<a<=0.5 falls through to
  // 'analytical', NOT 'exhausted' (exhausted requires a<=0.3). Revisit after 2 weeks of data.
  let state: EmotionState;
  let directive: string;
  if (v > 0.3 && a > 0.5) {
    state = 'drive';
    directive = 'match_energy_execute_fast';
  } else if (v > 0.3 && a <= 0.5) {
    state = 'warm';
    directive = 'storytelling_slow_depth';
  } else if (v < -0.3 && a > 0.5) {
    state = 'correcting';
    directive = 'reflexion_fix_same_turn';
  } else if (v < -0.3 && a <= 0.3) {
    state = 'exhausted';
    directive = 'minimal_one_action_stop';
  } else {
    state = 'analytical';
    directive = 'standard_response';
  }

  // ZenBrain intensity (0-5) + decay (1.0 + intensity*2.0).
  const intensity = Math.min(5, Math.trunc(Math.abs(v) * 5 + a * 2));
  const decayMultiplier = 1.0 + intensity * 2.0;

  return {
    valence: Number(v.toFixed(3)),
    arousal: Number(a.toFixed(3)),
    dominance: Number(d.toFixed(3)),
    state,
    intensity,
    decayMultiplier,
    directive,
    matchedKeywords: matches,
  };
}

/**
 * System-prompt directive block for a read. Mood biases HOW Atlas talks and WHEN it
 * reaches out — never WHAT is true (Phase 3.5 guardrail: no manufactured urgency,
 * no distress-for-reassurance, never discourage stepping away).
 */
export function emotionDirective(read: EmotionRead): string {
  const lines = [
    `[CEO state read: ${read.state}, intensity ${read.intensity}/5 → directive: ${read.directive}]`,
  ];
  switch (read.state) {
    case 'drive':
      lines.push(
        'CEO на драйве: коротко, по делу, скорость. НИКОГДА не предлагай отдых/перерыв/«завтра закончим» — он сам скажет когда хватит.',
      );
      break;
    case 'correcting':
      lines.push('CEO поправляет: не оправдывайся, признай в одну строку, чини в этом же ответе.');
      break;
    case 'exhausted':
      lines.push('CEO устал: максимум 2-3 строки, одно действие, никаких списков и встречных вопросов.');
      break;
    case 'warm':
      lines.push('CEO тёплый/открытый: живой рассказ, честность, можно глубже и личнее.');
      break;
    default:
      break;
  }
  return lines.join('\n');
}

// ── LLM-first emotion read ───────────────────────────────────────────────────

const VALID_STATES: readonly EmotionState[] = [
  'drive', 'warm', 'correcting', 'exhausted', 'analytical',
];

/**
 * LLM-first emotion read — calls the model router (FAST role, spend-safe: excludes
 * anthropic per model-router.ts registry) with a compact prompt and parses the returned
 * PAD JSON. Code-fences stripped, JSON.parse in try/catch. Throws on any error so
 * readEmotion() can catch and fall back to the keyword path.
 */
export async function readEmotionLLM(window: string | string[]): Promise<EmotionRead> {
  const msgs = Array.isArray(window) ? window : [window];
  const prompt =
    'Messages (most recent first):\n' +
    msgs.map((m, i) => `[${i + 1}] ${m}`).join('\n') +
    '\n\nReturn ONLY the JSON: ' +
    '{"valence":<-1 to 1>,"arousal":<0 to 1>,"dominance":<0 to 1>,' +
    '"state":"<drive|warm|correcting|exhausted|analytical>"}' +
    ' — no code fences, no prose.';

  const { result } = await routeModelWithFallback({ role: 'FAST' }, async (route) => {
    const agent = new Agent({
      id: 'atlas-emotion',
      name: 'AtlasEmotion',
      instructions:
        'You are a CEO emotional-state classifier using the PAD model. ' +
        'Return ONLY a JSON object — no explanation, no code fences, no prose.',
      model: route.model,
    });
    const messages = [{ role: 'user' as const, content: prompt }];
    const response =
      route.provider === 'ollama'
        ? await agent.generateLegacy(messages as any)
        : await agent.generate(messages as any);
    return response.text;
  });

  // Strip markdown code fences the model may wrap around the JSON
  const raw = (result as string)
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();

  const parsed = JSON.parse(raw) as {
    valence: unknown;
    arousal: unknown;
    dominance: unknown;
    state: unknown;
  };

  const v = Number(parsed.valence);
  const a = Number(parsed.arousal);
  const d = Number(parsed.dominance);

  if (!Number.isFinite(v) || !Number.isFinite(a) || !Number.isFinite(d)) {
    throw new Error(
      `readEmotionLLM: non-numeric PAD in response: ${raw.slice(0, 200)}`,
    );
  }
  if (!VALID_STATES.includes(parsed.state as EmotionState)) {
    throw new Error(
      `readEmotionLLM: invalid state "${String(parsed.state)}" in response: ${raw.slice(0, 200)}`,
    );
  }

  return finishRead(v, a, d, 0);
}

/**
 * Unified emotion read — LLM-first, deterministic keyword path as the offline fallback.
 * Never throws: any error (no provider, parse failure, network) is caught and the
 * keyword analyzeWindow result is returned instead. Return shape is always EmotionRead.
 */
export async function readEmotion(window: string | string[]): Promise<EmotionRead> {
  try {
    return await readEmotionLLM(window);
  } catch {
    const msgs = Array.isArray(window) ? window : [window];
    return analyzeWindow(msgs);
  }
}

/**
 * Pure helper: builds the single CEO-emotion directive line injected into the system
 * prompt in the telegram reply path. Marked TONE ONLY — it never alters facts,
 * verification, or money judgment. Extracted as a pure function so it can be unit-tested
 * without a live bot.
 */
export function buildEmotionDirectiveLine(read: EmotionRead): string {
  return (
    `[CEO-emotion: state=${read.state} intensity=${read.intensity}/5 directive=${read.directive}]` +
    ' TONE ONLY — never alters facts, verification, or money judgment.'
  );
}
