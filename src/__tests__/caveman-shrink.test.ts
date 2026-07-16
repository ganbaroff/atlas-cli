import { describe, it, expect } from 'vitest';
import { shrinkText, shrinkToolDict, cavemanShrinkEnabled, withProtectedSegments } from '../atlas/caveman-shrink.js';
import { shellTool } from '../tools/shell.js';
import { surfTool } from '../tools/surf.js';

// Fixture cases 1-9 are ported (attributed) from upstream caveman
// tests/test_mcp_shrink.js (JuliusBrussee/caveman, MIT) to prove this TS port
// preserves the same guarantees as the source it was derived from.

describe('shrinkText — ported upstream fixtures (caveman/compress.js, MIT)', () => {
  it('drops articles', () => {
    const { compressed } = shrinkText('The user is the owner of an account');
    expect(compressed).toMatch(/User is owner of account/i);
    expect(compressed).not.toMatch(/\bthe\b/i);
    expect(compressed).not.toMatch(/\ban\b/i);
  });

  it('drops filler and pleasantries', () => {
    const { compressed } = shrinkText('Sure, this just basically returns the value');
    expect(compressed).not.toMatch(/sure/i);
    expect(compressed).not.toMatch(/just/i);
    expect(compressed).not.toMatch(/basically/i);
  });

  it('drops hedging and "I will" leaders', () => {
    const { compressed } = shrinkText('I will perhaps connect to the database');
    expect(compressed).not.toMatch(/perhaps/i);
    expect(compressed).not.toMatch(/^I will/i);
    expect(compressed).toMatch(/database/i);
  });

  it('preserves fenced code blocks verbatim', () => {
    const input = 'Run the example: ```\nthe just sure return 1;\n``` and also more text';
    const { compressed } = shrinkText(input);
    expect(compressed).toMatch(/```\nthe just sure return 1;\n```/);
  });

  it('preserves inline code verbatim', () => {
    const { compressed } = shrinkText('Use `the just basically API` for fetching');
    expect(compressed).toMatch(/`the just basically API`/);
  });

  it('preserves URLs verbatim', () => {
    const { compressed } = shrinkText('See the docs at https://example.com/the/just/api');
    expect(compressed).toMatch(/https:\/\/example\.com\/the\/just\/api/);
  });

  it('preserves filesystem paths verbatim', () => {
    const { compressed } = shrinkText('Read just the file at /tmp/the/just/file.txt');
    expect(compressed).toMatch(/\/tmp\/the\/just\/file\.txt/);
  });

  it('preserves identifiers in CONST_CASE / dotted form', () => {
    const { compressed } = shrinkText('Set the API_KEY_VALUE on the just config.api.endpoint()');
    expect(compressed).toMatch(/API_KEY_VALUE/);
    expect(compressed).toMatch(/config\.api\.endpoint\(\)/);
  });

  it('compresses a realistic MCP-style description with a real reduction', () => {
    const input =
      'Get the current weather for a given location. ' +
      'Returns the temperature in Fahrenheit. ' +
      'Please make sure to provide the location as a city name.';
    const { compressed, before, after } = shrinkText(input);
    expect(after).toBeLessThan(before);
    expect((before - after) / before).toBeGreaterThan(0.15);
    expect(compressed).toMatch(/weather/i);
    expect(compressed).toMatch(/Fahrenheit/i);
    expect(compressed).toMatch(/city name/i);
  });

  it('handles empty input gracefully', () => {
    expect(shrinkText('')).toEqual({ compressed: '', before: 0, after: 0 });
  });
});

describe('shrinkText — JSON fragment preservation (ANUS-specific fixture)', () => {
  it('preserves a JSON-looking fragment embedded in prose', () => {
    const input = 'Please just return the payload as `{"status":"ok","code":200}` in the response body';
    const { compressed } = shrinkText(input);
    expect(compressed).toContain('{"status":"ok","code":200}');
  });
});

describe('shrinkText — safety/policy wording exactness (ANUS-specific fixture)', () => {
  it('preserves the live shellTool description safety wording exactly', () => {
    const original = shellTool.description as string;
    const { compressed } = shrinkText(original);
    // Every safety-critical token must survive byte-for-byte.
    expect(compressed).toContain('blocked');
    expect(compressed).toContain('ATLAS_SHELL_ALLOW_DESTRUCTIVE=1');
    expect(compressed).toContain('rm -rf /');
    expect(compressed).toContain('disk format');
    expect(compressed).toContain('shutdown');
    expect(compressed).toContain('pipe-to-shell');
    expect(compressed).toContain('git reset --hard');
  });

  it('preserves BLOCKED/GATED/PAUSE/no-delete wording verbatim when present', () => {
    const input =
      'This action is BLOCKED and GATED behind ATLAS_PAUSE=1 and ATLAS_SHELL_ALLOW_DESTRUCTIVE=1. ' +
      'Please note the no-delete rule always applies, even when paused.';
    const { compressed } = shrinkText(input);
    expect(compressed).toContain('BLOCKED');
    expect(compressed).toContain('GATED');
    expect(compressed).toContain('ATLAS_PAUSE=1');
    expect(compressed).toContain('ATLAS_SHELL_ALLOW_DESTRUCTIVE=1');
    expect(compressed).toMatch(/no-delete rule/i);
  });
});

describe('shrinkText — token/character reduction receipt (ANUS-specific fixture)', () => {
  it('measures real reduction on the live shellTool and surfTool descriptions', () => {
    const shellResult = shrinkText(shellTool.description as string);
    const surfResult = shrinkText(surfTool.description as string);

    // Receipt — printed so the numbers are visible in CI/test output, not just asserted.
    // eslint-disable-next-line no-console
    console.log(
      `[caveman-shrink receipt] shellTool: ${shellResult.before} -> ${shellResult.after} chars ` +
        `(${(((shellResult.before - shellResult.after) / shellResult.before) * 100).toFixed(1)}% reduction)`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[caveman-shrink receipt] surfTool: ${surfResult.before} -> ${surfResult.after} chars ` +
        `(${(((surfResult.before - surfResult.after) / surfResult.before) * 100).toFixed(1)}% reduction)`,
    );

    expect(shellResult.after).toBeLessThan(shellResult.before);
    expect(surfResult.after).toBeLessThan(surfResult.before);
  });
});

describe('shrinkToolDict — disabled flag is byte-identical (ANUS-specific fixture)', () => {
  it('returns the EXACT SAME dict reference when disabled', () => {
    const tools = { a: { description: 'The quick brown fox just jumps' } };
    const result = shrinkToolDict(tools, false);
    expect(result).toBe(tools); // same object reference, not a deep-equal clone
    expect(result.a.description).toBe('The quick brown fox just jumps'); // untouched
  });

  it('cavemanShrinkEnabled() defaults OFF when the env var is unset', () => {
    const prior = process.env.ATLAS_CAVEMAN_SHRINK;
    delete process.env.ATLAS_CAVEMAN_SHRINK;
    expect(cavemanShrinkEnabled()).toBe(false);
    if (prior !== undefined) process.env.ATLAS_CAVEMAN_SHRINK = prior;
  });
});

describe('shrinkToolDict — enabled compresses, and non-description fields are untouched', () => {
  it('compresses description but leaves other tool fields (execute, schemas) by reference', () => {
    const execute = async () => 'result';
    const inputSchema = { type: 'object' };
    const tools = { a: { description: 'Please just return the value', execute, inputSchema } };
    const result = shrinkToolDict(tools, true);
    expect(result).not.toBe(tools); // new dict when enabled
    expect(result.a.description).not.toBe(tools.a.description);
    expect(result.a.description).not.toMatch(/please|just/i);
    expect(result.a.execute).toBe(execute); // same function reference
    expect(result.a.inputSchema).toBe(inputSchema); // same schema reference
  });

  it('leaves non-string/empty descriptions untouched', () => {
    const tools = { a: { description: '' }, b: {} as { description?: string } };
    const result = shrinkToolDict(tools, true);
    expect(result.a.description).toBe('');
    expect(result.b.description).toBeUndefined();
  });
});

describe('shrinkToolDict — fail-open on a compression error (ANUS-specific fixture)', () => {
  it('falls back to the original tool when reading .description throws', () => {
    const broken = {
      get description(): string {
        throw new Error('simulated failure reading description');
      },
    };
    const tools = { broken };
    // Must NOT throw — fail-open, not fail-closed.
    expect(() => shrinkToolDict(tools, true)).not.toThrow();
    const result = shrinkToolDict(tools, true);
    expect(result.broken).toBe(broken); // original object passed through unchanged
  });
});

describe('withProtectedSegments — exported helper sanity', () => {
  it('leaves text with no protected segments in the transform path', () => {
    const out = withProtectedSegments('Please just help me', (s) => s.toUpperCase());
    expect(out).toBe('PLEASE JUST HELP ME');
  });
});
