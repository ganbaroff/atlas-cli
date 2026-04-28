/**
 * Atlas voice validator — pure local regex/heuristic.
 * No LLM call. No network. No filesystem. Safe to run anywhere.
 */

export interface Breach {
  type: string;
  sample: string;
  rule_ref: string;
}

export interface VoiceCheckResult {
  passed: boolean;
  breaches: Breach[];
}

const BANNED_OPENERS = ['Готово. Вот что я сделал', 'Отлично!'];
const BOLD_HEADER_RE = /^\*\*[A-Za-zА-Яа-яЁё]/;
const BULLET_RE = /^\s*[-*]\s+[A-Za-zА-Яа-яЁё*]/;
const TABLE_SEP_RE = /^\s*\|[-:\s|]+\|\s*$/;
const OPTION_MARKER_RE = /\b(option|variant|вариант|опция)\b/i;

function firstNonEmpty(lines: string[]): string {
  for (const l of lines) {
    const t = l.trim();
    if (t) return t;
  }
  return '';
}

function lastNonEmpty(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return '';
}

export function validateVoice(text: string): VoiceCheckResult {
  const breaches: Breach[] = [];
  const lines = text.split('\n');

  const boldHeaderLines = lines.filter((l) => BOLD_HEADER_RE.test(l.trim()));
  if (boldHeaderLines.length >= 3) {
    breaches.push({
      type: 'bold-headers-in-chat',
      sample: boldHeaderLines[0].slice(0, 120),
      rule_ref: 'atlas/voice.md#banned-structural-habits',
    });
  }

  const bulletIndices: number[] = [];
  lines.forEach((l, i) => {
    if (BULLET_RE.test(l)) bulletIndices.push(i);
  });
  let wallFound = false;
  for (let i = 0; i + 3 < bulletIndices.length; i++) {
    if (bulletIndices[i + 3] - bulletIndices[i] <= 10) {
      wallFound = true;
      break;
    }
  }
  if (wallFound) {
    breaches.push({
      type: 'bullet-wall',
      sample: lines[bulletIndices[0]].slice(0, 120),
      rule_ref: 'atlas/voice.md#banned-structural-habits',
    });
  }

  const tableRows = lines.filter((l) => TABLE_SEP_RE.test(l));
  if (tableRows.length >= 1) {
    breaches.push({
      type: 'markdown-table-in-conversation',
      sample: tableRows[0].slice(0, 120),
      rule_ref: 'atlas/voice.md#banned-structural-habits',
    });
  }

  const last = lastNonEmpty(lines);
  if (
    last &&
    last.endsWith('?') &&
    last.length < 100 &&
    !OPTION_MARKER_RE.test(text)
  ) {
    breaches.push({
      type: 'trailing-question-on-reversible',
      sample: last.slice(0, 120),
      rule_ref: 'atlas/voice.md#trailing-question-ban',
    });
  }

  const first = firstNonEmpty(lines);
  if (first) {
    for (const banned of BANNED_OPENERS) {
      if (first.startsWith(banned)) {
        breaches.push({
          type: 'banned-opener',
          sample: first.slice(0, 120),
          rule_ref: 'atlas/voice.md#banned-openers',
        });
        break;
      }
    }
  }

  return { passed: breaches.length === 0, breaches };
}
