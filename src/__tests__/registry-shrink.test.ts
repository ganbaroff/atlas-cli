import { afterEach, describe, expect, it, vi } from 'vitest';

// Proves the actual live wiring point (registry.ts::getToolDict), not just the
// standalone caveman-shrink module — this is the DoD requirement "explicit
// proof Atlas remains byte-identical when the feature flag is off."

describe('registry.ts getToolDict — caveman-shrink wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('flag OFF (default): descriptions are byte-identical to the un-shrunk originals', async () => {
    vi.stubEnv('ATLAS_CAVEMAN_SHRINK', '');
    const { getToolDict } = await import('../tools/registry.js');
    const { shellTool } = await import('../tools/shell.js');
    const { surfTool } = await import('../tools/surf.js');

    const dict = getToolDict('cli');
    expect(dict.shellTool.description).toBe(shellTool.description);
    expect(dict.surfTool.description).toBe(surfTool.description);
    // Every channel returns the same 8-tool set.
    expect(Object.keys(dict).sort()).toEqual(
      ['readFileTool', 'writeFileTool', 'globTool', 'grepTool', 'shellTool', 'listSkillsTool', 'loadSkillTool', 'surfTool'].sort(),
    );
  });

  it('flag ON: shellTool description is compressed but safety wording survives', async () => {
    vi.stubEnv('ATLAS_CAVEMAN_SHRINK', '1');
    const { getToolDict } = await import('../tools/registry.js');
    const { shellTool } = await import('../tools/shell.js');

    const dict = getToolDict('cli');
    expect(dict.shellTool.description).not.toBe(shellTool.description);
    expect((dict.shellTool.description as string).length).toBeLessThan((shellTool.description as string).length);
    expect(dict.shellTool.description).toContain('ATLAS_SHELL_ALLOW_DESTRUCTIVE=1');
    expect(dict.shellTool.description).toContain('rm -rf /');
    // Non-description fields are unaffected.
    expect(dict.shellTool.execute).toBe(shellTool.execute);
  });

  it('same channel behavior for cli/telegram/swarm', async () => {
    vi.stubEnv('ATLAS_CAVEMAN_SHRINK', '');
    const { getToolDict } = await import('../tools/registry.js');
    const cli = getToolDict('cli');
    const telegram = getToolDict('telegram');
    const swarm = getToolDict('swarm');
    expect(Object.keys(cli).sort()).toEqual(Object.keys(telegram).sort());
    expect(Object.keys(cli).sort()).toEqual(Object.keys(swarm).sort());
  });
});
