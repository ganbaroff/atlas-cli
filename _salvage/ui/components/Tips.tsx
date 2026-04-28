/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { type Config } from '@anus-dev/anus-core';

interface TipsProps {
  config: Config;
}

export const Tips: React.FC<TipsProps> = ({ config }) => {
  const anusMdFileCount = config.getAnusMdFileCount();
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={Colors.AccentPurple}>
          Welcome to ANUS - Autonomous Networked Utility System
        </Text>
      </Box>
      <Text color={Colors.Gray} italic>
        Powered by Grok&apos;s uncensored intelligence &bull; Born from AI,
        built by AI
      </Text>
      <Box marginTop={1}>
        <Text color={Colors.Foreground}>Tips for getting started:</Text>
      </Box>
      <Text color={Colors.Foreground}>
        1. Ask questions, edit files, or run commands.
      </Text>
      <Text color={Colors.Foreground}>
        2. Be specific for the best results.
      </Text>
      {anusMdFileCount === 0 && (
        <Text color={Colors.Foreground}>
          3. Create{' '}
          <Text bold color={Colors.AccentPurple}>
            ANUS.md
          </Text>{' '}
          files to customize your interactions with ANUS.
        </Text>
      )}
      <Text color={Colors.Foreground}>
        {anusMdFileCount === 0 ? '4.' : '3.'}{' '}
        <Text bold color={Colors.AccentPurple}>
          /help
        </Text>{' '}
        for more information.
      </Text>
    </Box>
  );
};
