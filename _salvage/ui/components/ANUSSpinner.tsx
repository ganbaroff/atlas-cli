/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { Colors } from '../colors.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';

interface ANUSSpinnerProps {
  /**
   * Animation speed in milliseconds per frame
   */
  speed?: number;
}

export const ANUSSpinner: React.FC<ANUSSpinnerProps> = ({ speed = 120 }) => {
  const [frameIndex, setFrameIndex] = useState(0);
  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);

  // Claude Code exact spinner animation: rotating 4-frame pattern
  const fullFrames = [
    '✱', // Heavy eight pointed star
    '✦', // Black four pointed star
    '+', // Plus sign
    '✦', // Black four pointed star
  ];

  // Same pattern for narrow terminals
  const narrowFrames = [
    '✱', // Heavy eight pointed star
    '✦', // Black four pointed star
    '+', // Plus sign
    '✦', // Black four pointed star
  ];

  const frames = isNarrow ? narrowFrames : fullFrames;

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prevIndex) => (prevIndex + 1) % frames.length);
    }, speed);

    return () => clearInterval(interval);
  }, [frames.length, speed]);

  const currentFrame = frames[frameIndex];

  // Use light grey color for the entire animation
  return <Text color={Colors.Gray}>{currentFrame}</Text>;
};
