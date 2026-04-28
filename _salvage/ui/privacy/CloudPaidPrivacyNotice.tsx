/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Newline, Text } from 'ink';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface CloudPaidPrivacyNoticeProps {
  onExit: () => void;
}

export const CloudPaidPrivacyNotice = ({
  onExit,
}: CloudPaidPrivacyNoticeProps) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onExit();
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={Colors.AccentPurple}>
        ANUS Privacy Notice
      </Text>
      <Newline />
      <Text bold color={Colors.AccentGreen}>
        No data collection. Your privacy is respected.
      </Text>
      <Newline />
      <Text>
        ANUS (Autonomous Networked Utility System) operates entirely on your
        local machine. We do not collect, store, or transmit any user data,
        prompts, code, or usage information to any servers.
      </Text>
      <Newline />
      <Text>
        All interactions with LLM providers (such as Grok/xAI) are made directly
        from your machine using your API keys.
      </Text>
      <Newline />
      <Text>For more information, visit:</Text>
      <Text color={Colors.AccentBlue}>
        https://github.com/anus-dev/anus/docs/tos-privacy.md
      </Text>
      <Newline />
      <Text color={Colors.Gray}>Press Esc to exit.</Text>
    </Box>
  );
};
