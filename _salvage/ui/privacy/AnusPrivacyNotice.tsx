/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Newline, Text } from 'ink';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface AnusPrivacyNoticeProps {
  onExit: () => void;
}

export const AnusPrivacyNotice = ({ onExit }: AnusPrivacyNoticeProps) => {
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
        ANUS API Key Notice
      </Text>
      <Newline />
      <Text>
        By using ANUS (Autonomous Networked Utility System)
        <Text color={Colors.AccentBlue}>[1]</Text> powered by Grok
        <Text color={Colors.AccentRed}>[2]</Text>, you are agreeing to the ANUS
        Terms of Service (the &quot;Terms&quot;)
        <Text color={Colors.AccentGreen}>[3]</Text> and acknowledge that this
        project was born from AI, built by community
        <Text color={Colors.AccentPurple}>[4]</Text>.
      </Text>
      <Newline />
      <Text>
        <Text color={Colors.AccentBlue}>[1]</Text>{' '}
        https://github.com/anus-dev/anus
      </Text>
      <Text>
        <Text color={Colors.AccentRed}>[2]</Text> https://x.ai (Grok by xAI)
      </Text>
      <Text>
        <Text color={Colors.AccentGreen}>[3]</Text>{' '}
        https://github.com/anus-dev/anus/docs/tos-privacy.md
      </Text>
      <Text>
        <Text color={Colors.AccentPurple}>[4]</Text>{' '}
        https://github.com/anus-dev/anus/README.md
      </Text>
      <Newline />
      <Text color={Colors.Gray}>Press Esc to exit.</Text>
    </Box>
  );
};
