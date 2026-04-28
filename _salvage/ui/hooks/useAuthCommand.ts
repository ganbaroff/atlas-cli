/**
 * @license
 * Copyright 2025 Google LLC
 * Modifications Copyright 2025 ANUS Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import {
  AuthType,
  Config,
  clearCachedCredentialFile,
  getErrorMessage,
} from '@anus-dev/anus-core';

export const useAuthCommand = (
  settings: LoadedSettings,
  setAuthError: (error: string | null) => void,
  config: Config,
) => {
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(() => {
    // Show auth dialog when no auth method is configured
    if (settings.merged.selectedAuthType === undefined) {
      const hasGrokKey =
        process.env['GROK_API_KEY'] || settings.merged.grok?.apiKey;

      // Only skip auth dialog if we have a valid API key
      if (hasGrokKey) {
        return false;
      }
      // Show auth dialog to prompt for API key setup
      return true;
    }
    return false;
  });

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    const authFlow = async () => {
      const authType = settings.merged.selectedAuthType;
      if (isAuthDialogOpen || !authType) {
        return;
      }

      try {
        setIsAuthenticating(true);
        await config.refreshAuth(authType);
        console.log(`Authenticated via "${authType}".`);
      } catch (e) {
        setAuthError(
          `Grok authentication failed - please check your API key: ${getErrorMessage(e)}`,
        );
        openAuthDialog();
      } finally {
        setIsAuthenticating(false);
      }
    };

    void authFlow();
  }, [isAuthDialogOpen, settings, config, setAuthError, openAuthDialog]);

  const handleAuthSelect = useCallback(
    async (authType: AuthType | undefined, scope: SettingScope) => {
      if (authType) {
        await clearCachedCredentialFile();

        settings.setValue(scope, 'selectedAuthType', authType);
      }
      setIsAuthDialogOpen(false);
      setAuthError(null);
    },
    [settings, setAuthError],
  );

  const handleApiKeySubmit = useCallback(
    async (apiKey: string, scope: SettingScope) => {
      try {
        // Clear any cached credentials first
        await clearCachedCredentialFile();

        // Save the API key to settings
        // First get existing grok settings or create new object
        const existingGrok = settings.merged.grok || {};
        const newGrok = { ...existingGrok, apiKey };
        settings.setValue(scope, 'grok', newGrok);
        settings.setValue(scope, 'selectedAuthType', AuthType.USE_GROK);

        // Close the auth dialog
        setIsAuthDialogOpen(false);
        setAuthError(null);

        console.log('Grok API key saved successfully - ANUS is ready!');
      } catch (e) {
        setAuthError(`Failed to save API key. Message: ${getErrorMessage(e)}`);
      }
    },
    [settings, setAuthError],
  );

  const cancelAuthentication = useCallback(() => {
    setIsAuthenticating(false);
  }, []);

  return {
    isAuthDialogOpen,
    openAuthDialog,
    handleAuthSelect,
    handleApiKeySubmit,
    isAuthenticating,
    cancelAuthentication,
  };
};
