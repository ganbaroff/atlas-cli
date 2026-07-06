/**
 * surf — native web-surf capability for the Atlas brain.
 *
 * Browses a public URL and returns clean, useful content:
 *   - always: the page title + main readable text (article body, nav/script stripped).
 *   - optionally: structured JSON when an extraction `question` is supplied, produced by
 *     the existing model-router on a FREE provider (canon: never Claude as swarm agent).
 *
 * Design choice (2026-07-07): pure-TS `fetch` + dependency-free HTML→text extraction,
 * NOT the scrapegraphai Python bridge. Rationale: scrapegraphai needs a 453 MB venv +
 * Playwright + a fragile Gemini free-tier quota (see
 * C:/Projects/ATLAS/experiments/scrapegraph-trial/PROOF.md). A pure-TS path adds ZERO new
 * npm deps, keeps the tool surface stable, and reuses the proven router. Trade-off honestly
 * noted: this fetches raw HTML and does NOT execute JavaScript, so JS-rendered SPAs (client
 * -side-only content) will return little text. For those, the OpenManus browser hands remain
 * the escalation path. Static news/docs/blog/wiki pages — the overwhelming majority — work.
 */

import { createTool } from '@mastra/core/tools';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { routeModelWithFallback } from '../model-router.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_CONTENT_CHARS = 12_000; // cap returned text; also bounds LLM input cost
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 AtlasSurf/0.1';

/** Minimal HTML entity decode for the entities that survive tag-stripping. */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
    lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©',
    reg: '®', trade: '™', deg: '°',
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name] ?? m);
}

function safeCodePoint(cp: number): string {
  try {
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  } catch {
    return '';
  }
}

/** Extract <title> for a human-readable page label. */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) : '';
}

/**
 * Strip HTML to readable main-content text.
 * Removes non-content elements, prefers <article>/<main> when present, then flattens tags,
 * decodes entities, and collapses whitespace.
 */
function htmlToText(html: string): string {
  let doc = html;

  // Kill non-content regions entirely (including their inner text).
  doc = doc.replace(
    /<(script|style|noscript|template|svg|head|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi,
    ' ',
  );
  // Drop HTML comments.
  doc = doc.replace(/<!--[\s\S]*?-->/g, ' ');

  // Prefer the main article region if the page marks one — big signal-to-noise win.
  const region =
    matchRegion(doc, 'article') ||
    matchRegion(doc, 'main') ||
    doc;

  let text = region;
  // Turn block-level boundaries into newlines so paragraphs survive.
  text = text.replace(/<\/(p|div|section|li|h[1-6]|tr|br)\s*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Strip all remaining tags.
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  // Normalize whitespace: collapse runs of spaces/tabs, cap blank-line runs.
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');

  return text;
}

/** Return the inner HTML of the first <tag>...</tag> region, or '' if absent. */
function matchRegion(html: string, tag: string): string {
  const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}

export const surfTool = createTool({
  id: 'surf',
  description:
    'Surf the web: browse a public URL and return its useful content. Returns the page ' +
    'title and clean main-article text. If an extraction `question` is given, also returns ' +
    'structured JSON answering it (via a free LLM provider). Fetches raw HTML — does not run ' +
    'client-side JavaScript, so JS-only SPAs may return little text. Use for news, docs, blogs, wikis.',
  inputSchema: z.object({
    url: z.string().url().describe('The public http(s) URL to surf'),
    question: z
      .string()
      .optional()
      .describe('Optional: what to extract, e.g. "list the top 5 headlines as {title,url}"'),
  }),
  outputSchema: z.object({
    url: z.string(),
    title: z.string(),
    content: z.string().describe('Clean main-content text, truncated'),
    structured: z.string().optional().describe('LLM-structured answer (JSON string) when a question was given'),
    provider: z.string().optional().describe('Free provider used for structuring'),
    truncated: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ url, question }) => {
    // Guard: only http(s). Never let the brain fetch file:// or other schemes.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { url, title: '', content: '', truncated: false, error: 'Invalid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url, title: '', content: '', truncated: false, error: `Unsupported scheme: ${parsed.protocol}` };
    }

    let html: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { url, title: '', content: '', truncated: false, error: `HTTP ${res.status} ${res.statusText}` };
      }
      html = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { url, title: '', content: '', truncated: false, error: `Fetch failed: ${msg}` };
    }

    const title = extractTitle(html);
    const full = htmlToText(html);
    const truncated = full.length > MAX_CONTENT_CHARS;
    const content = truncated ? full.slice(0, MAX_CONTENT_CHARS) : full;

    // No question → return clean readable content and stop (no LLM cost).
    if (!question) {
      return { url, title, content, truncated };
    }

    // Question → structure with a FREE provider (never Claude in the swarm).
    try {
      const { result, route } = await routeModelWithFallback(
        { role: 'WORKER', excludeProviders: ['anthropic'] },
        async (r) => {
          const extractor = new Agent({
            id: 'atlas-surf-extractor',
            name: 'Atlas Surf Extractor',
            instructions:
              'You are a precise web-content extractor. Given page content and a request, ' +
              'return ONLY valid JSON that answers the request. No prose, no markdown fences.',
            model: r.model,
          });
          const prompt =
            `REQUEST: ${question}\n\nPAGE TITLE: ${title}\n\nPAGE CONTENT:\n${content}`;
          const response =
            r.provider === 'ollama'
              ? await extractor.generateLegacy(prompt)
              : await extractor.generate(prompt);
          return response.text;
        },
      );
      const structured = (result as string).trim();
      return { url, title, content, structured, provider: route.provider, truncated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Structuring failed — still return the raw content so the surf isn't wasted.
      return { url, title, content, truncated, error: `Structuring failed: ${msg}` };
    }
  },
});
