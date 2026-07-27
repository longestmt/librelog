/**
 * One interface for credentials that LibreLog stores in the current profile.
 *
 * The current web implementation uses IndexedDB settings. This interface keeps
 * provider code independent from that storage choice so a native keychain or
 * encrypted web implementation can replace it without changing integrations.
 */

import { getSetting, setSetting } from './db.js';

const CREDENTIAL_KEYS = Object.freeze({
  aiApiKey: 'ai_api_key',
  usdaApiKey: 'usda_api_key',
  webdavPassword: 'webdavPassword',
  githubPat: 'githubPAT',
});

const LEGACY_KEYS = Object.freeze({
  webdavPassword: ['webdav_password'],
});

function settingKey(name) {
  const key = CREDENTIAL_KEYS[name];
  if (!key) throw new Error(`Unknown credential name: ${name}`);
  return key;
}

export async function getCredential(name) {
  const value = await getSetting(settingKey(name), null);
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
  const normalized = typeof value === 'string' ? value.trim() : '';
  await setSetting(settingKey(name), normalized || null);
  for (const legacyKey of LEGACY_KEYS[name] || []) {
    await setSetting(legacyKey, null);
  }
}

export async function removeCredential(name) {
  await setCredential(name, null);
}

export { CREDENTIAL_KEYS };
