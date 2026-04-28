/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { Config } from '@anus-dev/anus-core';

export interface PrivacyState {
  isLoading: boolean;
  error?: string;
  isFreeTier?: boolean;
  dataCollectionOptIn?: boolean;
}

export const usePrivacySettings = (_config: Config) => {
  // Stub implementation - ANUS doesn't collect any data
  // Return static values to maintain component compatibility
  const [privacyState] = useState<PrivacyState>({
    isLoading: false,
    isFreeTier: false, // Set to false to avoid showing opt-in dialogs
    dataCollectionOptIn: false, // Always false - no data collection
  });

  const updateDataCollectionOptIn = useCallback(async (_optIn: boolean) => {
    // No-op - ANUS doesn't collect data
    // Function kept for backward compatibility
  }, []);

  return {
    privacyState,
    updateDataCollectionOptIn,
  };
};

// Removed helper functions for CodeAssistServer as ANUS doesn't use them
// The privacy settings are now a simple stub that always returns "no data collection"
