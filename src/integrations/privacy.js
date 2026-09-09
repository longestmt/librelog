import { getSetting, setSetting } from '../data/db.js';
import { withDataLifecycleLock } from '../data/operation-locks.js';

const CONSENT_KEY_PREFIX = 'privacyConsent_';

/**
 * Read the durable opt-in for a remote provider. Keeping this check outside
 * page components lets every integration enforce the same privacy boundary.
 *
 * @param {string} providerKey Stable provider identifier (for example, "openfoodfacts")
 * @returns {Promise<boolean>}
 */
export async function hasRemoteProviderConsent(providerKey) {
  if (!providerKey) return false;
  return (await getSetting(`${CONSENT_KEY_PREFIX}${providerKey}`, false)) === true;
}

export function getRemoteProviderConsentSettingKey(providerKey) {
  return `${CONSENT_KEY_PREFIX}${providerKey}`;
}

/** Persist consent only after a page has shown the provider-specific disclosure. */
export async function grantRemoteProviderConsent(providerKey, {
  lockManager,
  mutationGeneration,
} = {}) {
  if (!providerKey) throw new Error('A provider key is required');
  return withDataLifecycleLock(
    () => setSetting(getRemoteProviderConsentSettingKey(providerKey), true, {
      lockManager,
      mutationGeneration,
    }),
    lockManager,
  );
}
