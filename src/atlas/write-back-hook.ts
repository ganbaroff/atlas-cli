/**
 * M4-D — mechanical write-back breadcrumb before exit/compaction.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let breadcrumbWrittenThisSession = false;

function breadcrumbPath(): string {
  const dir = process.env.ATLAS_BREADCRUMB_DIR ?? join(homedir(), '.atlas');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'session-breadcrumb.jsonl');
}

export interface SessionBreadcrumb {
  ts: string;
  pid: number;
  note: string;
}

/** Append one breadcrumb line (idempotent per session if note matches last write). */
export function writeSessionBreadcrumb(note: string): void {
  const entry: SessionBreadcrumb = {
    ts: new Date().toISOString(),
    pid: process.pid,
    note: note.slice(0, 500),
  };
  appendFileSync(breadcrumbPath(), `${JSON.stringify(entry)}\n`, 'utf8');
  breadcrumbWrittenThisSession = true;
}

export function hasSessionBreadcrumb(): boolean {
  return breadcrumbWrittenThisSession;
}

export function assertBreadcrumbBeforeExit(): { ok: true } | { ok: false; message: string } {
  if (breadcrumbWrittenThisSession) return { ok: true };
  if (existsSync(breadcrumbPath())) {
    breadcrumbWrittenThisSession = true;
    return { ok: true };
  }
  return {
    ok: false,
    message: 'exit blocked: no session breadcrumb written — call writeSessionBreadcrumb() before exit',
  };
}

/** For tests only. */
export function resetBreadcrumbStateForTests(): void {
  breadcrumbWrittenThisSession = false;
}
