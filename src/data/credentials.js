/**
 * One interface for credentials that LibreLog stores in the current profile.
 *
 * The current web implementation uses IndexedDB settings. This interface keeps
 * provider code independent from that storage choice so a native keychain or
 * encrypted web implementation can replace it without changing integrations.
 */

import { getSetting, setSetting, setSettings } from './db.js';
import { withDataLifecycleLock } from './operation-locks.js';
import { decryptBackup, encryptBackup, isEncryptedBackup } from './encryption.js';

const CREDENTIAL_KEYS = Object.freeze({
  aiApiKey: 'ai_api_key',
  usdaApiKey: 'usda_api_key',
  webdavPassword: 'webdavPassword',
  githubPat: 'githubPAT',
});

const LEGACY_KEYS = Object.freeze({
  webdavPassword: ['webdav_password'],
});
const ENCRYPTION_SETTING = 'credentialEncryptionEnabled';
const ENCRYPTION_VERIFIER_SETTING = 'credentialEncryptionVerifier';
const unlockedCredentials = new Map();
let credentialPassphrase = null;

function settingKey(name) {
  const key = CREDENTIAL_KEYS[name];
  if (!key) throw new Error(`Unknown credential name: ${name}`);
  return key;
}

export async function getCredential(name) {
  const value = await getSetting(settingKey(name), null);
  if (isEncryptedBackup(value)) {
    return unlockedCredentials.get(name) || null;
  }
  if (typeof value === 'string' && value) return value;
  for (const legacyKey of LEGACY_KEYS[name] || []) {
    const legacyValue = await getSetting(legacyKey, null);
    if (typeof legacyValue === 'string' && legacyValue) return legacyValue;
  }
  return null;
}

export async function hasCredential(name) {
  return Boolean(await getCredential(name));
}

export async function setCredential(name, value) {
  // Passwords are exact byte sequences. Trimming a WebDAV password after a
  // successful connection test would save a different credential for later
  // backup and restore requests. API keys retain their existing normalization.
  const normalized = typeof value === 'string'
    ? (name === 'webdavPassword' ? value : value.trim())
    : '';
  if (await isCredentialEncryptionEnabled()) {
    if (!credentialPassphrase) {
      throw new Error('Unlock credential protection before you change a credential');
    }
    const encrypted = normalized
      ? await encryptBackup({ credential: name, value: normalized }, credentialPassphrase)
      : null;
    await setSetting(settingKey(name), encrypted);
    if (normalized) unlockedCredentials.set(name, normalized);
    else unlockedCredentials.delete(name);
  } else {
    await setSetting(settingKey(name), normalized || null);
  }
  for (const legacyKey of LEGACY_KEYS[name] || []) {
    await setSetting(legacyKey, null);
  }
}

export async function removeCredential(name) {
  await setCredential(name, null);
}

export async function hasStoredCredential(name) {
  const value = await getSetting(settingKey(name), null);
  if (isEncryptedBackup(value)) return true;
  if (typeof value === 'string' && value) return true;
  for (const legacyKey of LEGACY_KEYS[name] || []) {
    const legacyValue = await getSetting(legacyKey, null);
    if (typeof legacyValue === 'string' && legacyValue) return true;
  }
  return false;
}

export async function isCredentialEncryptionEnabled() {
  return Boolean(await getSetting(ENCRYPTION_SETTING, false));
}

export async function isCredentialStoreUnlocked() {
  return !(await isCredentialEncryptionEnabled()) || Boolean(credentialPassphrase);
}

async function enableCredentialEncryptionWithLifecycleLockHeld(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('Passphrase must contain at least 8 characters');
  }
  const encryptedValues = new Map();
  const plaintextValues = new Map();
  const verifier = await encryptBackup({ credential: 'verifier', value: 'librelog' }, passphrase);

  for (const name of Object.keys(CREDENTIAL_KEYS)) {
    const value = await getCredential(name);
    if (!value) continue;
    plaintextValues.set(name, value);
    encryptedValues.set(
      name,
      await encryptBackup({ credential: name, value }, passphrase),
    );
  }

  const writes = new Map();
  for (const [name, encrypted] of encryptedValues) {
    writes.set(settingKey(name), encrypted);
    for (const legacyKey of LEGACY_KEYS[name] || []) {
      writes.set(legacyKey, null);
    }
  }
  writes.set(ENCRYPTION_VERIFIER_SETTING, verifier);
  writes.set(ENCRYPTION_SETTING, true);
  await setSettings([...writes].map(([key, value]) => ({ key, value })));
  credentialPassphrase = passphrase;
  unlockedCredentials.clear();
  for (const [name, value] of plaintextValues) unlockedCredentials.set(name, value);
}

export async function enableCredentialEncryption(passphrase, { lockManager } = {}) {
  return withDataLifecycleLock(
    () => enableCredentialEncryptionWithLifecycleLockHeld(passphrase),
    lockManager,
  );
}

export async function saveUsdaApiKey(value, { lockManager } = {}) {
  return withDataLifecycleLock(async () => {
    // Consent is the request-side active marker and remains false on any
    // partial credential update.
    await setSetting('privacyConsent_usda', false);
    await setCredential('usdaApiKey', value);
    await setSetting('privacyConsent_usda', true);
  }, lockManager);
}

export async function removeUsdaApiKey({ lockManager } = {}) {
  return withDataLifecycleLock(async () => {
    await setSetting('privacyConsent_usda', false);
    await removeCredential('usdaApiKey');
  }, lockManager);
}

export async function unlockCredentialStore(passphrase) {
  if (!(await isCredentialEncryptionEnabled())) return true;
  const verifier = await getSetting(ENCRYPTION_VERIFIER_SETTING, null);
  const verifierData = await decryptBackup(verifier, passphrase);
  if (verifierData?.credential !== 'verifier' || verifierData.value !== 'librelog') {
    throw new Error('Credential passphrase is incorrect');
  }
  const decryptedValues = new Map();

  for (const name of Object.keys(CREDENTIAL_KEYS)) {
    const stored = await getSetting(settingKey(name), null);
    if (!isEncryptedBackup(stored)) continue;
    const decrypted = await decryptBackup(stored, passphrase);
    if (decrypted?.credential !== name || typeof decrypted.value !== 'string') {
      throw new Error('Encrypted credential data is invalid');
    }
    decryptedValues.set(name, decrypted.value);
  }

  credentialPassphrase = passphrase;
  unlockedCredentials.clear();
  for (const [name, value] of decryptedValues) unlockedCredentials.set(name, value);
  return true;
}

export function lockCredentialStore() {
  credentialPassphrase = null;
  unlockedCredentials.clear();
}

export { CREDENTIAL_KEYS };
