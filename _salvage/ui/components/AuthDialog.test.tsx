/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthDialog } from './AuthDialog.js';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { AuthType } from '@anus-dev/anus-core';
import { renderWithProviders } from '../../test-utils/render.js';

describe('AuthDialog', () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env['GROK_API_KEY'] = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should show API key input interface', () => {
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: undefined,
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { lastFrame } = renderWithProviders(
      <AuthDialog
        onSelect={() => {}}
        onApiKeySubmit={() => {}}
        settings={settings}
      />,
    );

    expect(lastFrame()).toContain('Configure Grok API Key');
    expect(lastFrame()).toContain('Enter your API key:');
    expect(lastFrame()).toContain('https://openrouter.ai/keys');
  });

  it('should show error message when provided', () => {
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: { selectedAuthType: undefined },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { lastFrame } = renderWithProviders(
      <AuthDialog
        onSelect={() => {}}
        onApiKeySubmit={() => {}}
        settings={settings}
        initialErrorMessage="Test error message"
      />,
    );

    expect(lastFrame()).toContain('Test error message');
  });

  describe('GROK_API_KEY environment variable', () => {
    it('should detect GROK_API_KEY environment variable', () => {
      process.env['GROK_API_KEY'] = 'sk-or-v1-foobar';

      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            selectedAuthType: undefined,
            customThemes: {},
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: { customThemes: {}, mcpServers: {} },
          path: '',
        },
        {
          settings: { customThemes: {}, mcpServers: {} },
          path: '',
        },
        [],
      );

      const { lastFrame } = renderWithProviders(
        <AuthDialog
          onSelect={() => {}}
          onApiKeySubmit={() => {}}
          settings={settings}
        />,
      );

      expect(lastFrame()).toContain(
        'Existing OpenRouter API key detected in environment',
      );
    });
  });

  it('should call onApiKeySubmit when valid API key is entered', async () => {
    const onApiKeySubmit = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: undefined,
          customThemes: {},
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { stdin, unmount } = renderWithProviders(
      <AuthDialog
        onSelect={() => {}}
        onApiKeySubmit={onApiKeySubmit}
        settings={settings}
      />,
    );
    await wait();

    // Type a valid API key
    const apiKey = 'sk-or-v1-test-key-123456789';
    for (const char of apiKey) {
      stdin.write(char);
    }
    await wait();

    // Press enter to submit
    stdin.write('\r');
    await wait();

    expect(onApiKeySubmit).toHaveBeenCalledWith(apiKey, SettingScope.User);
    unmount();
  });

  it('should not allow escaping when no auth method is selected', async () => {
    const onSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: undefined,
          customThemes: {},
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { stdin, unmount } = renderWithProviders(
      <AuthDialog
        onSelect={onSelect}
        onApiKeySubmit={() => {}}
        settings={settings}
      />,
    );
    await wait();

    // Simulate pressing escape key
    stdin.write('\u001b'); // ESC key
    await wait();

    // Should not call onSelect since no auth method is configured
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('should display initial error message', async () => {
    const onSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: undefined,
          customThemes: {},
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { lastFrame, unmount } = renderWithProviders(
      <AuthDialog
        onSelect={onSelect}
        onApiKeySubmit={() => {}}
        settings={settings}
        initialErrorMessage="Initial error"
      />,
    );
    await wait();

    expect(lastFrame()).toContain('Initial error');
    unmount();
  });

  it('should allow exiting when auth method is already selected', async () => {
    const onSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      {
        settings: {
          selectedAuthType: AuthType.USE_GROK,
          customThemes: {},
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { customThemes: {}, mcpServers: {} },
        path: '',
      },
      [],
    );

    const { stdin, unmount } = renderWithProviders(
      <AuthDialog
        onSelect={onSelect}
        onApiKeySubmit={() => {}}
        settings={settings}
      />,
    );
    await wait();

    // Simulate pressing escape key
    stdin.write('\u001b'); // ESC key
    await wait();

    // Should call onSelect with undefined to exit
    expect(onSelect).toHaveBeenCalledWith(undefined, SettingScope.User);
    unmount();
  });
});
