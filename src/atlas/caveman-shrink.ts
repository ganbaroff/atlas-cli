/**
 * caveman-shrink — optional, deterministic tool-description compressor.
 *
 * Faithful TypeScript port of compress.js from caveman
 * (https://github.com/JuliusBrussee/caveman,
 * src/mcp-servers/caveman-shrink/compress.js), MIT License:
 *
 *   MIT License
 *   Copyright (c) 2026 Julius Brussee
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to
 *   the following conditions: The above copyright notice and this
 *   permission notice shall be included in all copies or substantial
 *   portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 *   WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 *   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 *   LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 *   OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 *   WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * See docs/CAVEMAN-ADOPTION.md for the exact integration seam and enable flag.
 *
 * WHAT THIS DOES: shrinks a Mastra tool's .description string to cut the
 * token overhead of the tool-definition payload sent to the model on every
 * agent.generate() call. Only the description field is ever touched —
 * inputSchema/outputSchema/execute pass through by reference, untouched.
 *
 * SAFETY:
 *   - Opt-in only: cavemanShrinkEnabled() (ATLAS_CAVEMAN_SHRINK unset/0/false
 *     => disabled). Disabled => shrinkToolDict returns the EXACT SAME dict
 *     reference passed in — byte-identical, zero-copy, not even a clone.
 *   - Fail-open: a per-tool compression error falls back to that tool's
 *     original description; a bug here can never break agent boot/chat.
 *   - Protected segments (fenced/inline code, URLs, paths, CONST_CASE env
 *     names, dotted.method()/fn() calls, semver) survive byte-for-byte via a
 *     sentinel-substitution pass BEFORE any prose rule runs.
 *   - Operates only on compile-time tool-description string literals — never
 *     on user input, secrets, model output, memory writes, or shell content.
 */

export interface ShrinkResult {
  compressed: string;
  before: number;
  after: number;
}

// Regexes ported verbatim from upstream compress.js.
const FILLERS = /\b(?:just|really|basically|actually|simply|quite|very|essentially|literally)\b/gi;
const PLEASANTRIES = /\b(?:please|kindly|thank you|thanks|sure|certainly|of course|happy to|i'?d be happy)\b[,.]?\s*/gi;
const HEDGES = /\b(?:perhaps|maybe|might|could potentially|would like to|i think|in my opinion|it seems|it appears)\b\s*/gi;
const LEADERS = /^(?:i'?ll|i will|i can|i'?d|you can|we will|we can|let me|let'?s)\s+/gim;
const ARTICLES = /\b(?:a|an|the)\s+(?=[a-z])/gi;

// Tokens never touched, even inside prose. Order matters (matches upstream).
const PROTECTED_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g, // fenced code
  /`[^`\n]+`/g, // inline code
  /\bhttps?:\/\/\S+/gi, // URLs
  /\b[\w.-]*[/\\][\w./\\-]+/g, // paths with / or \
  /\b[A-Z][A-Za-z0-9]*(?:_[A-Z][A-Za-z0-9]*)+\b/g, // CONST_CASE
  /\b\w+\.\w+(?:\.\w+)*\(\)?/g, // dotted.method or pkg.fn()
  /[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)/g, // function calls
  /\b\d+\.\d+\.\d+\b/g, // version numbers
];

/**
 * Replace every protected match with a sentinel, transform the rest, splice
 * originals back.
 *
 * IMPORTANT: the sentinel delimiter is NUL (`\0`), not a space. Reading the
 * upstream source through a text viewer, NUL bytes render as invisible/blank
 * and look identical to a plain space — an earlier draft of this port
 * transcribed them as literal spaces, which silently broke restoration
 * whenever a protected segment ended a string or sat next to whitespace that
 * `compressProse`'s own cleanup/`.trim()` collapsed away (space-delimited
 * sentinels are not collision-proof; NUL bytes never occur in normal prose,
 * so they are). Verified against upstream via a byte-level dump of
 * caveman-shrink/compress.js: `` `\0${i}\0` `` / `/\0(\d+)\0/g`.
 */
export function withProtectedSegments(text: string, transform: (s: string) => string): string {
  const segments: string[] = [];
  let working = text;
  for (const re of PROTECTED_PATTERNS) {
    working = working.replace(re, (m) => {
      const i = segments.length;
      segments.push(m);
      return `\0${i}\0`;
    });
  }
  let out = transform(working);
  out = out.replace(/\0(\d+)\0/g, (m, i: string) => segments[Number(i)] ?? m);
  return out;
}

function compressProse(text: string): string {
  let s = text;
  s = s.replace(LEADERS, '');
  s = s.replace(PLEASANTRIES, '');
  s = s.replace(HEDGES, '');
  s = s.replace(FILLERS, '');
  s = s.replace(ARTICLES, '');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/\s+([,.;:!?])/g, '$1');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  return s.trim();
}

/** Deterministic, non-LLM description compressor. Mirrors upstream compress(). */
export function shrinkText(text: string): ShrinkResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { compressed: text, before: 0, after: 0 };
  }
  const before = text.length;
  const compressed = withProtectedSegments(text, compressProse);
  return { compressed, before, after: compressed.length };
}

export interface ShrinkableTool {
  description?: string;
}

/**
 * Return a tool dict with each tool's .description compressed, IF enabled.
 * Disabled (default): returns the SAME `tools` object reference, unchanged.
 * Enabled: returns a NEW dict; each entry is a shallow clone with only
 * `.description` replaced — inputSchema/outputSchema/execute keep their
 * original references. A per-tool compression failure falls back to that
 * tool's original description (fail-open) rather than throwing.
 */
export function shrinkToolDict<T extends ShrinkableTool>(
  tools: Record<string, T>,
  enabled: boolean,
): Record<string, T> {
  if (!enabled) return tools;
  const out: Record<string, T> = {};
  for (const [key, tool] of Object.entries(tools)) {
    // Whole block guarded, not just shrinkText(): reading `.description` itself
    // could throw (e.g. a getter) — fail-open must cover that too.
    try {
      const desc = tool?.description;
      if (typeof desc !== 'string' || desc.length === 0) {
        out[key] = tool;
        continue;
      }
      const { compressed } = shrinkText(desc);
      out[key] = { ...tool, description: compressed };
    } catch (err) {
      console.error(
        `[caveman-shrink] compression failed for tool "${key}", using original description:`,
        (err as Error)?.message,
      );
      out[key] = tool;
    }
  }
  return out;
}

/** ATLAS_CAVEMAN_SHRINK=1/true/yes enables; default OFF. */
export function cavemanShrinkEnabled(): boolean {
  const v = (process.env.ATLAS_CAVEMAN_SHRINK ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
