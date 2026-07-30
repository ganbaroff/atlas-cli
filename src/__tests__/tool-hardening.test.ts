import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isBlockedHost, surfTool } from '../tools/surf.js';
import { isRiskyPattern, grepTool } from '../tools/grep.js';
import { isSensitivePath, auditLogPath } from '../tools/fs-guard.js';
import { writeFileTool } from '../tools/write-file.js';
import { readFileTool } from '../tools/read-file.js';

const CTX = {} as never;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Parse the shared JSONL audit log defensively — it may be written concurrently by other test files. */
async function readAuditEntries(path: string): Promise<Record<string, unknown>[]> {
  const log = await readFile(path, 'utf-8');
  return log
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

describe('isBlockedHost', () => {
  it('blocks loopback addresses', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('::1')).toBe(true);
  });

  it('blocks link-local addresses incl. the cloud-metadata endpoint', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('169.254.0.1')).toBe(true);
  });

  it('blocks RFC1918 private ranges', () => {
    expect(isBlockedHost('10.0.0.5')).toBe(true);
    expect(isBlockedHost('172.16.0.1')).toBe(true);
    expect(isBlockedHost('172.31.255.255')).toBe(true);
    expect(isBlockedHost('192.168.1.1')).toBe(true);
  });

  it('blocks unspecified addresses', () => {
    expect(isBlockedHost('0.0.0.0')).toBe(true);
    expect(isBlockedHost('::')).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('1.1.1.1')).toBe(false);
    expect(isBlockedHost('172.32.0.1')).toBe(false); // just outside 172.16.0.0/12
  });
});

describe('isRiskyPattern', () => {
  it('rejects nested-quantifier catastrophic shapes', () => {
    expect(isRiskyPattern('(a+)+')).toBe(true);
    expect(isRiskyPattern('(a*)*')).toBe(true);
    expect(isRiskyPattern('(a+)*')).toBe(true);
    expect(isRiskyPattern('(.*){2,}')).toBe(true);
  });

  it('rejects oversized patterns', () => {
    expect(isRiskyPattern('a'.repeat(600))).toBe(true);
  });

  it('allows normal patterns', () => {
    expect(isRiskyPattern('normal.*text')).toBe(false);
    expect(isRiskyPattern('Atlas')).toBe(false);
    expect(isRiskyPattern('(foo|bar)+')).toBe(false);
  });
});

describe('isSensitivePath', () => {
  it('flags dotenv files', () => {
    expect(isSensitivePath('/home/user/project/.env')).toBe(true);
    expect(isSensitivePath('/home/user/project/.env.local')).toBe(true);
  });

  it('flags secrets/keys dirs and key material', () => {
    expect(isSensitivePath('/home/user/secrets/x')).toBe(true);
    expect(isSensitivePath('/home/user/keys/x')).toBe(true);
    expect(isSensitivePath('/home/user/.ssh/id_rsa')).toBe(true);
    expect(isSensitivePath('/home/user/certs/server.pem')).toBe(true);
    expect(isSensitivePath('/home/user/certs/server.key')).toBe(true);
    expect(isSensitivePath('/repo/.git/config')).toBe(true);
  });

  it('allows ordinary paths', () => {
    expect(isSensitivePath('/home/user/project/notes.txt')).toBe(false);
    expect(isSensitivePath('/home/user/my-secrets-talk/notes.txt')).toBe(false);
  });
});

describe('surf SSRF guard (literal IPs — dns.lookup resolves locally, no network)', () => {
  it('blocks a loopback URL without fetching', async () => {
    const result = await surfTool.execute!({ url: 'http://127.0.0.1:9/' }, CTX);
    expect(result.error).toBe('blocked: private/loopback/link-local address not allowed');
    expect(result.content).toBe('');
  });

  it('blocks the cloud-metadata address without fetching', async () => {
    const result = await surfTool.execute!({ url: 'http://169.254.169.254/latest/meta-data/' }, CTX);
    expect(result.error).toBe('blocked: private/loopback/link-local address not allowed');
  });

  it('blocks a private RFC1918 URL without fetching', async () => {
    const result = await surfTool.execute!({ url: 'http://10.0.0.5/' }, CTX);
    expect(result.error).toBe('blocked: private/loopback/link-local address not allowed');
  });
});

describe('grep ReDoS guard', () => {
  it('rejects a catastrophic pattern before running the match loop', async () => {
    const target = join(ROOT, 'package.json');
    const result = await grepTool.execute!({ pattern: '(a+)+', paths: [target] }, CTX);
    expect(result.error).toBe('pattern rejected: possible ReDoS');
    expect(result.matches).toEqual([]);
  });

  it('rejects an oversized pattern', async () => {
    const target = join(ROOT, 'package.json');
    const result = await grepTool.execute!({ pattern: 'a'.repeat(600), paths: [target] }, CTX);
    expect(result.error).toBe('pattern rejected: possible ReDoS');
  });

  it('still matches normal patterns', async () => {
    const target = join(ROOT, 'src', '__tests__', 'identity.test.ts');
    const result = await grepTool.execute!({ pattern: 'Atlas', paths: [target] }, CTX);
    expect(result.error).toBeUndefined();
    expect(result.matches.length).toBeGreaterThan(0);
  });
});

describe('write-file / read-file governance', () => {
  const TMP_DIR = join(ROOT, 'src', '__tests__', 'tmp-hardening');
  const ENV_PATH = join(TMP_DIR, '.env');
  const SECRETS_PATH = join(TMP_DIR, 'secrets', 'x.txt');
  const NORMAL_PATH = join(TMP_DIR, 'notes.txt');

  beforeEach(() => {
    delete process.env.ATLAS_SHELL_ALLOW_DESTRUCTIVE;
  });

  afterAll(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it('write-file refuses .env without the opt-in and audits the refusal', async () => {
    const result = await writeFileTool.execute!({ path: ENV_PATH, content: 'SECRET=1' }, CTX);
    expect(result.written).toBe(false);
    expect(result.error).toMatch(/REFUSED/i);

    const entries = await readAuditEntries(auditLogPath());
    const mine = entries.filter((e) => e.path === ENV_PATH);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[mine.length - 1].decision).toBe('refused');
    expect(mine[mine.length - 1].op).toBe('write');
  });

  it('write-file writes .env when the opt-in is set', async () => {
    process.env.ATLAS_SHELL_ALLOW_DESTRUCTIVE = '1';
    const result = await writeFileTool.execute!({ path: ENV_PATH, content: 'SECRET=1' }, CTX);
    expect(result.written).toBe(true);
    const content = await readFile(ENV_PATH, 'utf-8');
    expect(content).toBe('SECRET=1');
  });

  it('write-file writes ordinary paths normally without the opt-in', async () => {
    const result = await writeFileTool.execute!({ path: NORMAL_PATH, content: 'hello' }, CTX);
    expect(result.written).toBe(true);
  });

  it('read-file refuses secrets/x without the opt-in and audits the refusal', async () => {
    const result = await readFileTool.execute!({ path: SECRETS_PATH }, CTX);
    expect(result.content).toBe('');
    expect(result.error).toMatch(/REFUSED/i);

    const entries = await readAuditEntries(auditLogPath());
    const mine = entries.filter((e) => e.path === SECRETS_PATH);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[mine.length - 1].decision).toBe('refused');
    expect(mine[mine.length - 1].op).toBe('read');
  });

  it('read-file reads ordinary paths normally', async () => {
    await writeFileTool.execute!({ path: NORMAL_PATH, content: 'hello again' }, CTX);
    const result = await readFileTool.execute!({ path: NORMAL_PATH }, CTX);
    expect(result.content).toBe('hello again');
    expect(result.error).toBeUndefined();
  });
});
