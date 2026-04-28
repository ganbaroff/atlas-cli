/**
 * Semantic dedup for swarm perspective outputs.
 * Inspired by Cloudflare's multi-reviewer pattern — 7 agents, meta-dedup.
 *
 * Approach: extract key claims from each perspective, find near-duplicates
 * by normalized token overlap, merge into unique findings.
 */

/** Normalize text for comparison: lowercase, strip punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split text into sentences (rough). */
function sentences(text: string): string[] {
  return text
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

/** Jaccard similarity of word sets. */
function jaccard(a: string, b: string): number {
  const setA = new Set(normalize(a).split(' '));
  const setB = new Set(normalize(b).split(' '));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export interface DedupResult {
  unique: string[];
  duplicatesRemoved: number;
  totalInput: number;
}

/**
 * Dedup claims across multiple perspective outputs.
 * threshold: Jaccard similarity above this = duplicate (default 0.6).
 */
export function dedupFindings(
  perspectiveOutputs: string[],
  threshold = 0.6,
): DedupResult {
  // Collect all sentences from all perspectives
  const allSentences: { text: string; source: number }[] = [];
  for (let i = 0; i < perspectiveOutputs.length; i++) {
    for (const s of sentences(perspectiveOutputs[i])) {
      allSentences.push({ text: s, source: i });
    }
  }

  const unique: string[] = [];
  const used = new Set<number>();

  for (let i = 0; i < allSentences.length; i++) {
    if (used.has(i)) continue;

    let isDup = false;
    for (const existing of unique) {
      if (jaccard(allSentences[i].text, existing) >= threshold) {
        isDup = true;
        break;
      }
    }

    if (!isDup) {
      unique.push(allSentences[i].text);
    } else {
      used.add(i);
    }
  }

  return {
    unique,
    duplicatesRemoved: allSentences.length - unique.length,
    totalInput: allSentences.length,
  };
}
