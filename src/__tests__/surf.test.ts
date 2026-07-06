import { describe, it, expect } from 'vitest';
import { surfTool } from '../tools/index.js';

const CTX = {} as never;

describe('surf tool', () => {
  it('rejects non-http(s) schemes without fetching', async () => {
    const result = await surfTool.execute!({ url: 'file:///etc/passwd' }, CTX);
    expect(result.error).toMatch(/Unsupported scheme/i);
    expect(result.content).toBe('');
  });

  it('surfs a real static page and extracts title + content', async () => {
    // example.com is the canonical stable, JS-free test page.
    const result = await surfTool.execute!({ url: 'https://example.com/' }, CTX);
    expect(result.error).toBeUndefined();
    expect(result.title).toMatch(/Example Domain/i);
    expect(result.content).toMatch(/for use in documentation examples/i);
  }, 30_000);
});
