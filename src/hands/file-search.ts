/**
 * M5 — file-search hand implementation (read-only).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface FileSearchHit {
  path: string;
  line?: number;
  preview?: string;
}

export interface FileSearchResult {
  ok: boolean;
  hits: FileSearchHit[];
  error?: string;
}

/** Bounded recursive search under root for files matching name/content pattern. */
export function runFileSearch(opts: {
  root: string;
  pattern: string;
  maxHits?: number;
}): FileSearchResult {
  const root = resolve(opts.root);
  if (!existsSync(root)) {
    return { ok: false, hits: [], error: `root not found: ${root}` };
  }
  const maxHits = opts.maxHits ?? 50;
  const re = new RegExp(opts.pattern, 'i');
  const hits: FileSearchHit[] = [];

  function walk(dir: string): void {
    if (hits.length >= maxHits) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= maxHits) return;
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, full).replace(/\\/g, '/');
      if (re.test(name) || re.test(rel)) {
        hits.push({ path: rel });
        continue;
      }
      // Content scan for small text files only
      if (st.size > 256_000) continue;
      try {
        const text = readFileSync(full, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            hits.push({ path: rel, line: i + 1, preview: lines[i]!.slice(0, 200) });
            break;
          }
        }
      } catch {
        /* binary / unreadable */
      }
    }
  }

  walk(root);
  return { ok: true, hits };
}
