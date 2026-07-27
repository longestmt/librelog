import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  BACKUP_SCHEMA_VERSION,
  DATA_SCHEMA_VERSION,
  clearAllData,
  exportAllData,
  getAll,
  getSetting,
  importAllData,
  put,
  setSetting,
} from '../src/data/db.js';
import {
  getCredential,
  enableCredentialEncryption,
  hasCredential,
  hasStoredCredential,
  lockCredentialStore,
  removeCredential,
  setCredential,
  unlockCredentialStore,
} from '../src/data/credentials.js';

test('a credential-free backup survives a full replacement round-trip', async () => {
  await clearAllData();
  await put('foods', { id: 'roundtrip-food', name: 'Round-trip food' });
  await put('meals', {
    id: 'roundtrip-meal',
    date: '2026-07-27',
    type: 'lunch',
    items: [{ foodId: 'roundtrip-food', quantity: 1, unit: 'serving' }],
  });
  await setSetting('theme', 'lauds');
  await setSetting('ai_api_key', 'must-stay-local');

  const backup = await exportAllData();
  assert.equal(backup.version, BACKUP_SCHEMA_VERSION);
  assert.equal(backup.dataVersion, DATA_SCHEMA_VERSION);
  assert.equal(backup.secretsExcluded, true);
  assert.equal(backup.stores.settings.some(record => record.key === 'ai_api_key'), false);

  await clearAllData();
  await setSetting('ai_api_key', 'replacement-profile-secret');
  await importAllData(backup);

  assert.deepEqual((await getAll('foods')).map(record => record.id), ['roundtrip-food']);
  assert.deepEqual((await getAll('meals')).map(record => record.id), ['roundtrip-meal']);
  assert.equal(await getSetting('theme'), 'lauds');
  assert.equal(await getSetting('ai_api_key'), 'replacement-profile-secret');
});

test('the credential adapter preserves current storage behavior', async () => {
  await setCredential('usdaApiKey', ' test-usda-key ');
  assert.equal(await hasCredential('usdaApiKey'), true);
  assert.equal(await getCredential('usdaApiKey'), 'test-usda-key');
  await removeCredential('usdaApiKey');
  assert.equal(await getCredential('usdaApiKey'), null);
  await assert.rejects(() => getCredential('unknownCredential'), /unknown credential/i);
});

test('optional credential protection encrypts secrets at rest', async () => {
  await clearAllData();
  await setCredential('aiApiKey', 'private-api-key');
  await enableCredentialEncryption('credential vault passphrase');

  const stored = await getSetting('ai_api_key');
  assert.equal(typeof stored, 'object');
  assert.equal(JSON.stringify(stored).includes('private-api-key'), false);
  assert.equal(await getCredential('aiApiKey'), 'private-api-key');

  lockCredentialStore();
  assert.equal(await hasStoredCredential('aiApiKey'), true);
  assert.equal(await getCredential('aiApiKey'), null);
  await assert.rejects(
    unlockCredentialStore('wrong credential passphrase'),
    /incorrect|damaged/i,
  );
  await unlockCredentialStore('credential vault passphrase');
  assert.equal(await getCredential('aiApiKey'), 'private-api-key');
});
