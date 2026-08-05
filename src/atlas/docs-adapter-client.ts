/**
 * HTTP client for local Atlas documents FastAPI adapter (ADR-0010 Phase 2).
 */
import { readFileSync } from 'node:fs';

export type DocsHealth = {
  ok: boolean;
  service: string;
  version: string;
  role: string;
  brain: boolean;
  scheduler: boolean;
  taskAuthority: boolean;
  python?: string;
  engines?: Record<string, unknown>;
  peakRssMb?: number;
  easyocrForbidden?: boolean;
};

const DEFAULT_BASE = process.env.ATLAS_DOCS_URL ?? 'http://127.0.0.1:8766';

export function docsBaseUrl(override?: string): string {
  return (override ?? DEFAULT_BASE).replace(/\/$/, '');
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`docs-adapter HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

export async function docsHealth(baseUrl?: string): Promise<DocsHealth> {
  const res = await fetch(`${docsBaseUrl(baseUrl)}/health`);
  return parseJson<DocsHealth>(res);
}

export async function docsOcr(opts: {
  filePath: string;
  engine?: 'primary' | 'fallback' | 'auto';
  forcePrimaryFail?: boolean;
  baseUrl?: string;
}): Promise<{ text: string; engine: string; easyocr: boolean }> {
  const buf = readFileSync(opts.filePath);
  const body = new FormData();
  body.set('file', new Blob([buf], { type: 'image/png' }), 'page.png');
  body.set('engine', opts.engine ?? 'auto');
  body.set('force_primary_fail', opts.forcePrimaryFail ? 'true' : 'false');
  const res = await fetch(`${docsBaseUrl(opts.baseUrl)}/ocr`, { method: 'POST', body });
  return parseJson(res);
}

export async function docsTable(opts: {
  filePath: string;
  baseUrl?: string;
}): Promise<{ engine: string; rows: string[][]; rowCount: number }> {
  const buf = readFileSync(opts.filePath);
  const body = new FormData();
  body.set('file', new Blob([buf], { type: 'image/png' }), 'table.png');
  const res = await fetch(`${docsBaseUrl(opts.baseUrl)}/table`, { method: 'POST', body });
  return parseJson(res);
}

export async function docsWarmup(
  engines = 'vl,structure',
  baseUrl?: string,
): Promise<Record<string, unknown>> {
  const body = new FormData();
  body.set('engines', engines);
  const res = await fetch(`${docsBaseUrl(baseUrl)}/warmup`, { method: 'POST', body });
  return parseJson(res);
}

export async function docsVramGate(
  action = 'warmup',
  baseUrl?: string,
): Promise<Record<string, unknown>> {
  const body = new FormData();
  body.set('action', action);
  const res = await fetch(`${docsBaseUrl(baseUrl)}/vram-gate`, { method: 'POST', body });
  return parseJson(res);
}
