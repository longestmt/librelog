import { getSetting, setSetting } from '../data/db.js';
import { getCredential, removeCredential, setCredential } from '../data/credentials.js';
import { getDataLockManager, withDataLifecycleLock } from '../data/operation-locks.js';

export const AI_SETTINGS_LOCK_NAME = 'librelog:ai-settings:v1';

export async function withAISettingsLock(operation, lockManager = globalThis.navigator?.locks) {
  if (typeof operation !== 'function') throw new TypeError('An AI settings operation is required');
  return getDataLockManager(lockManager)
    .request(AI_SETTINGS_LOCK_NAME, { mode: 'exclusive' }, operation);
}

/**
 * Persist AI configuration without ever making a newly entered cloud key
 * usable by the previously selected provider. The provider binding acts as a
 * fail-closed guard while the multi-record update is in progress.
 */
export async function saveAISettingsSafely({
  provider,
  apiKey = '',
  model = '',
  ollamaUrl,
}, {
  writeSetting = setSetting,
  readSetting = getSetting,
  writeCredential = setCredential,
  readCredential = getCredential,
  deleteCredential = removeCredential,
  lockManager = globalThis.navigator?.locks,
} = {}) {
  const operation = async () => {
    const isCloudProvider = Boolean(provider && provider !== 'ollama');

    if (isCloudProvider && !apiKey) {
      const [existingKey, existingBinding] = await Promise.all([
        readCredential('aiApiKey'),
        readSetting('ai_api_key_provider', null),
      ]);
      if (!existingKey || existingBinding !== provider) {
        const error = new Error(`Please enter a new API key for ${provider}`);
        error.code = 'AI_KEY_REQUIRED';
        throw error;
      }
    }

    if (!provider) {
      await writeSetting('ai_api_key_provider', null);
      await deleteCredential('aiApiKey');
    } else if (isCloudProvider && apiKey) {
      // Disable cloud requests before replacing the shared credential. If any
      // later write fails, provider/key mismatch keeps the credential unusable.
      await writeSetting('ai_api_key_provider', null);
      await writeCredential('aiApiKey', apiKey);
      await writeSetting('ai_api_key_provider', provider);
    }

    await writeSetting('ai_model', model);
    await writeSetting('ai_ollama_url', ollamaUrl);
    if (isCloudProvider) {
      await writeSetting(`privacyConsent_ai_${provider}`, true);
    }
    // Activate the provider last, after its key binding, model, endpoint, and
    // consent record are ready.
    await writeSetting('ai_provider', provider);
  };

  return withDataLifecycleLock(
    () => withAISettingsLock(operation, lockManager),
    lockManager,
  );
}
