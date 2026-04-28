/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text } from 'ink';
import Spinner from 'ink-spinner';
import type { SpinnerName } from 'cli-spinners';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { ANUSSpinner } from './ANUSSpinner.js';

interface AnusRespondingSpinnerProps {
  /**
   * Optional string to display when not in Responding state.
   * If not provided and not Responding, renders null.
   */
  nonRespondingDisplay?: string;
  spinnerType?: SpinnerName | 'anus';
}

export const AnusRespondingSpinner: React.FC<AnusRespondingSpinnerProps> = ({
  nonRespondingDisplay,
  spinnerType = 'anus',
}) => {
  const streamingState = useStreamingContext();

  if (streamingState === StreamingState.Responding) {
    if (spinnerType === 'anus') {
      return <ANUSSpinner />;
    }
    return <Spinner type={spinnerType as SpinnerName} />;
  } else if (nonRespondingDisplay) {
    return <Text>{nonRespondingDisplay}</Text>;
  }
  return null;
};
