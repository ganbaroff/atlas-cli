/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { AuthType } from '@anus-dev/anus-core';
import { ApiKeyInput } from './ApiKeyInput.js';

interface AuthDialogProps {
  onSelect: (authMethod: AuthType | undefined, scope: SettingScope) => void;
  onApiKeySubmit: (apiKey: string, scope: SettingScope) => void;
  settings: LoadedSettings;
  initialErrorMessage?: string | null;
}

export function AuthDialog({
  onSelect,
  onApiKeySubmit,
  settings,
  initialErrorMessage,
}: AuthDialogProps): React.JSX.Element {
  const handleApiKeySubmit = useCallback(
    (apiKey: string) => {
      onApiKeySubmit(apiKey, SettingScope.User);
    },
    [onApiKeySubmit],
  );

  const handleCancel = useCallback(() => {
    // Only allow canceling if already authenticated
    if (settings.merged.selectedAuthType !== undefined) {
      onSelect(undefined, SettingScope.User);
    }
  }, [onSelect, settings.merged.selectedAuthType]);

  // Check if API key already exists in environment
  const existingApiKey =
    process.env['GROK_API_KEY'] || settings.merged.grok?.apiKey;
  const hasExistingKey = !!existingApiKey;

  // Show info about existing key but still allow input for new key
  const infoMessage = hasExistingKey
    ? 'Existing OpenRouter API key detected in environment. You can enter a new one below or press Escape to continue with the existing key.'
    : null;

  return (
    <Box flexDirection="column">
      <ApiKeyInput
        onSubmit={handleApiKeySubmit}
        onCancel={handleCancel}
        errorMessage={initialErrorMessage}
      />
      {infoMessage && (
        <Box marginTop={1} paddingX={1}>
          <Text color={Colors.Gray}>{infoMessage}</Text>
        </Box>
      )}
      <Box marginTop={1} paddingX={1}>
        <Text>ANUS Terms of Service and Privacy Notice</Text>
      </Box>
      <Box marginTop={1} paddingX={1}>
        <Text color={Colors.AccentBlue}>
          https://github.com/anus-dev/anus/docs/tos-privacy.md
        </Text>
      </Box>
    </Box>
  );
}
