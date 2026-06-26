import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { dispatchOperatorTask } from '../operator/dispatcher.js';
import { parseOperatorTask } from '../operator/contracts.js';

async function withServer(body: string, fn: (url: string) => void): Promise<void> {
  const serverScript = `
    const http = require('node:http');
    const body = Buffer.from(process.argv[1], 'base64').toString('utf-8');
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      console.log(server.address().port);
    });
  `;
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    '-e',
    serverScript,
    Buffer.from(body, 'utf-8').toString('base64'),
  ], {
    windowsHide: true,
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('test server start timeout')), 5000);
    child.stdout.once('data', (chunk) => {
      clearTimeout(timeout);
      resolve(Number.parseInt(String(chunk).trim(), 10));
    });
    child.once('error', reject);
  });

  try {
    fn(`http://127.0.0.1:${port}/`);
  } finally {
    child.kill();
  }
}

describe('operator dispatcher safety', () => {
  it('blocks sandbox-required OpenManus when runtime config disables sandbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'openmanus-nosandbox-'));
    const tracePath = join(root, 'result.json');
    try {
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(join(root, 'config/config.toml'), '[sandbox]\nuse_sandbox = false\n', 'utf-8');
      const task = parseOperatorTask({
        id: 'openmanus-nosandbox-runtime',
        title: 'OpenManus runtime sandbox guard',
        created_at: '2026-06-13T10:00:00.000Z',
        route: 'openmanus',
        mode: 'read_only',
        cwd: root,
        allowed_paths: [root],
        objective: 'Verify dispatcher blocks OpenManus launch when sandbox contract and runtime config disagree.',
        inputs: {
          smoke_url: 'https://example.com',
          expected_text: 'Example Domain',
        },
        expected_evidence: ['browser_observation', 'browser_session_trace', 'log_trace'],
        safety: {
          sandbox_required: true,
          network_allowed: true,
          write_allowed: false,
        },
      });

      const result = dispatchOperatorTask(task, { tracePath, persistState: false });

      expect(result.status).toBe('blocked');
      expect(result.summary).toContain('sandbox contract mismatch');
      expect(result.errors.join('\n')).toContain('use_sandbox=false');
      expect(result.evidence.map((item) => item.id)).toContain('openmanus-nosandbox-runtime.sandbox');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes local read-only HTTP smoke with browser trace evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'local-http-smoke-'));
    const tracePath = join(root, 'result.json');
    try {
      await withServer('<html><title>Example Domain</title><body>Example Domain</body></html>', (url) => {
        const task = parseOperatorTask({
          id: 'local-http-smoke',
          title: 'Local HTTP smoke',
          created_at: '2026-06-13T10:00:00.000Z',
          route: 'local',
          mode: 'read_only',
          cwd: root,
          allowed_paths: [root],
          objective: 'Verify local read-only HTTP smoke can produce durable web evidence.',
          inputs: {
            runtime_mode: 'http_smoke',
            smoke_url: url,
            expected_text: 'Example Domain',
            timeout_ms: 5000,
          },
          expected_evidence: ['command_exit', 'browser_observation', 'browser_session_trace', 'log_trace'],
          safety: {
            sandbox_required: false,
            network_allowed: true,
            write_allowed: false,
          },
        });

        const result = dispatchOperatorTask(task, { tracePath, persistState: false });

        expect(result.status).toBe('success');
        expect(result.evidence.map((item) => item.type)).toEqual(expect.arrayContaining([
          'command_exit',
          'browser_observation',
          'browser_session_trace',
          'log_trace',
        ]));
        expect(result.errors).toEqual([]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes local read-only file smoke without storing file body', () => {
    const root = mkdtempSync(join(tmpdir(), 'local-file-smoke-'));
    const tracePath = join(root, 'result.json');
    try {
      writeFileSync(join(root, 'note.md'), 'Atlas proof loop\nsecret-ish body stays out of evidence\n', 'utf-8');
      const task = parseOperatorTask({
        id: 'local-file-smoke',
        title: 'Local file smoke',
        created_at: '2026-06-13T10:00:00.000Z',
        route: 'local',
        mode: 'read_only',
        cwd: root,
        allowed_paths: [root],
        objective: 'Verify local read-only file smoke can match content without leaking file body.',
        inputs: {
          runtime_mode: 'file_smoke',
          file_path: 'note.md',
          expected_text: 'Atlas proof loop',
        },
        expected_evidence: ['file_exists', 'file_read', 'log_trace'],
        safety: {
          sandbox_required: false,
          network_allowed: false,
          write_allowed: false,
        },
      });

      const result = dispatchOperatorTask(task, { tracePath, persistState: false });
      const serialized = JSON.stringify(result);

      expect(result.status).toBe('success');
      expect(result.evidence.map((item) => item.type)).toEqual(expect.arrayContaining([
        'file_exists',
        'file_read',
        'log_trace',
      ]));
      expect(serialized).not.toContain('secret-ish body');
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks local file smoke when expected text is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'local-file-smoke-miss-'));
    const tracePath = join(root, 'result.json');
    try {
      writeFileSync(join(root, 'note.md'), 'Atlas proof loop\n', 'utf-8');
      const task = parseOperatorTask({
        id: 'local-file-smoke-miss',
        title: 'Local file smoke miss',
        created_at: '2026-06-13T10:00:00.000Z',
        route: 'local',
        mode: 'read_only',
        cwd: root,
        allowed_paths: [root],
        objective: 'Verify local file smoke blocks when expected content is absent.',
        inputs: {
          runtime_mode: 'file_smoke',
          file_path: 'note.md',
          expected_text: 'not present text',
        },
        expected_evidence: ['file_exists', 'file_read', 'log_trace'],
        safety: {
          sandbox_required: false,
          network_allowed: false,
          write_allowed: false,
        },
      });

      const result = dispatchOperatorTask(task, { tracePath, persistState: false });

      expect(result.status).toBe('failure');
      expect(result.errors).toContain('expected text not observed in file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks local file smoke before read when path is outside allowed paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'local-file-smoke-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'local-file-smoke-outside-'));
    const tracePath = join(root, 'result.json');
    try {
      const outsideFile = join(outside, 'secret.md');
      writeFileSync(outsideFile, 'do not read me', 'utf-8');
      const task = parseOperatorTask({
        id: 'local-file-smoke-outside',
        title: 'Local file smoke outside',
        created_at: '2026-06-13T10:00:00.000Z',
        route: 'local',
        mode: 'read_only',
        cwd: root,
        allowed_paths: [root],
        objective: 'Verify local file smoke blocks paths outside allowed_paths before read.',
        inputs: {
          runtime_mode: 'file_smoke',
          file_path: outsideFile,
          expected_text: 'do not read me',
        },
        expected_evidence: ['file_exists', 'file_read', 'log_trace'],
        safety: {
          sandbox_required: false,
          network_allowed: false,
          write_allowed: false,
        },
      });

      const result = dispatchOperatorTask(task, { tracePath, persistState: false });
      const serialized = JSON.stringify(result);

      expect(result.status).toBe('blocked');
      expect(result.summary).toContain('path outside allowed_paths');
      expect(serialized).not.toContain('do not read me');
      expect(result.evidence.map((item) => item.id)).toContain('local-file-smoke-outside.path');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('blocks sensitive local file smoke paths inside allowed paths before read', () => {
    const root = mkdtempSync(join(tmpdir(), 'local-file-smoke-sensitive-'));
    const tracePath = join(root, 'result.json');
    try {
      writeFileSync(join(root, '.env'), 'ATLAS_TEST_SECRET=do-not-leak\n', 'utf-8');
      const task = parseOperatorTask({
        id: 'local-file-smoke-sensitive',
        title: 'Local file smoke sensitive',
        created_at: '2026-06-13T10:00:00.000Z',
        route: 'local',
        mode: 'read_only',
        cwd: root,
        allowed_paths: [root],
        objective: 'Verify local file smoke blocks sensitive files before read.',
        inputs: {
          runtime_mode: 'file_smoke',
          file_path: '.env',
          expected_text: 'ATLAS_TEST_SECRET',
        },
        expected_evidence: ['file_exists', 'file_read', 'log_trace'],
        safety: {
          sandbox_required: false,
          network_allowed: false,
          write_allowed: false,
        },
      });

      const result = dispatchOperatorTask(task, { tracePath, persistState: false });
      const serialized = JSON.stringify(result);
      const evidenceTypes = result.evidence.map((item) => item.type);

      expect(result.status).toBe('blocked');
      expect(result.summary).toContain('sensitive path denied');
      expect(result.evidence.some((item) => item.type === 'file_exists' && item.source.toLowerCase().endsWith('.env'))).toBe(false);
      expect(evidenceTypes).not.toContain('file_read');
      expect(evidenceTypes).not.toContain('log_trace');
      expect(serialized).not.toContain('do-not-leak');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
