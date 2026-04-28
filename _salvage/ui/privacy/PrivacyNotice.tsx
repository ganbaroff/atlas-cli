/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from 'ink';
import { type Config } from '@anus-dev/anus-core';
import { AnusPrivacyNotice } from './AnusPrivacyNotice.js';

interface PrivacyNoticeProps {
  onExit: () => void;
  config: Config;
}

const PrivacyNoticeText = ({
  config: _config,
  onExit,
}: {
  config: Config;
  onExit: () => void;
}) => (
  // Always show the ANUS privacy notice regardless of auth type
  // Since ANUS doesn't collect any data
  <AnusPrivacyNotice onExit={onExit} />
);

export const PrivacyNotice = ({ onExit, config }: PrivacyNoticeProps) => (
  <Box borderStyle="round" padding={1} flexDirection="column">
    <PrivacyNoticeText config={config} onExit={onExit} />
  </Box>
);
