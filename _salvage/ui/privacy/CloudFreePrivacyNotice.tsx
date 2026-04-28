/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Newline, Text } from 'ink';
import { Config } from '@anus-dev/anus-core';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface CloudFreePrivacyNoticeProps {
  config: Config;
  onExit: () => void;
}

export const CloudFreePrivacyNotice = ({
  config: _config,
  onExit,
}: CloudFreePrivacyNoticeProps) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onExit();
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={Colors.AccentPurple}>
        ANUS Privacy Notice
      </Text>
      <Newline />
      <Text>
        ANUS (Autonomous Networked Utility System) respects your privacy.
      </Text>
      <Newline />
      <Text bold color={Colors.AccentGreen}>
        We do not collect any user data.
      </Text>
      <Newline />
      <Text>• Your prompts and code remain on your local machine</Text>
      <Text>• No telemetry or usage data is sent to any servers</Text>
      <Text>• Your API keys are stored locally and never shared</Text>
      <Text>
        • All processing happens through your chosen LLM provider (Grok/xAI)
      </Text>
      <Newline />
      <Text>For more information, see our Terms of Service:</Text>
      <Text color={Colors.AccentBlue}>
        https://github.com/anus-dev/anus/docs/tos-privacy.md
      </Text>
      <Newline />
      <Text color={Colors.Gray}>Press Escape to close this notice.</Text>
    </Box>
  );
};
