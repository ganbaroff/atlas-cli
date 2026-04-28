/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface ApiKeyInputProps {
  onSubmit: (apiKey: string) => void;
  onCancel: () => void;
  errorMessage?: string | null;
}

export function ApiKeyInput({
  onSubmit,
  onCancel,
  errorMessage,
}: ApiKeyInputProps): React.JSX.Element {
  const [input, setInput] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const validateApiKey = useCallback((key: string): string | null => {
    if (!key.trim()) {
      return 'API key cannot be empty';
    }
    if (!key.startsWith('sk-or-v1-')) {
      return 'Invalid API key format. OpenRouter API keys start with "sk-or-v1-"';
    }
    if (key.length < 20) {
      return 'API key appears to be too short';
    }
    return null;
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmedInput = input.trim();
    const validationError = validateApiKey(trimmedInput);

    if (validationError) {
      setLocalError(validationError);
      return;
    }

    setLocalError(null);
    onSubmit(trimmedInput);
  }, [input, validateApiKey, onSubmit]);

  useKeypress(
    (key) => {
      // Clear error on any key press except enter/escape
      if (key.name !== 'return' && key.name !== 'escape' && localError) {
        setLocalError(null);
      }

      if (key.name === 'return') {
        handleSubmit();
        return;
      }

      if (key.name === 'escape') {
        onCancel();
        return;
      }

      if (key.name === 'backspace' || key.name === 'delete') {
        setInput((prev) => prev.slice(0, -1));
        return;
      }

      // Handle ctrl+c
      if (key.ctrl && key.name === 'c') {
        onCancel();
        return;
      }

      // Add regular characters
      if (key.sequence && !key.ctrl && !key.meta) {
        // Single character
        if (key.sequence.length === 1) {
          const charCode = key.sequence.charCodeAt(0);
          if (charCode >= 32 && charCode <= 126) {
            setInput((prev) => prev + key.sequence);
          }
        } else {
          // Multi-character (paste)
          const cleaned = key.sequence.replace(/\s+/g, '').trim();
          if (cleaned) {
            setInput(cleaned);
          }
        }
      }
    },
    { isActive: true },
  );

  const displayError = errorMessage || localError;

  return (
    <Box
      borderStyle="round"
      borderColor={displayError ? Colors.AccentRed : Colors.Gray}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>Configure Grok API Key</Text>
      <Box marginTop={1}>
        <Text>ANUS runs on Grok via OpenRouter</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Enter your API key:</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.AccentBlue}>{input}█</Text>
      </Box>
      {displayError && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{displayError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>Press Enter to submit, Escape to cancel</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          Get your API key at: https://openrouter.ai/keys (select Grok models)
        </Text>
      </Box>
    </Box>
  );
}
