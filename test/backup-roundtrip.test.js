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
  softDelete,
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
  await put('foods', {
    id: 'roundtrip-food',
    name: 'Round-trip food',
    servingSize: { quantity: 1, unit: 'serving' },
    nutrients: {
      energy: { kcal: 100 },
      macros: { protein: { g: 1 }, carbs: { g: 2 }, fat: { g: 3 } },
      fiber: { g: null },
      sodium: { mg: null },
    },
  });
  await put('meals', {
    id: 'roundtrip-meal',
    date: '2026-07-27',
    type: 'lunch',
    items: [{ foodId: 'roundtrip-food', quantity: 1, unit: 'serving' }],
  });
  await setSetting('theme', 'lauds');
  await setSetting('ai_api_key', 'must-stay-local');
  await put('meals', {
    id: 'deleted-meal',
    date: '2026-07-26',
    type: 'dinner',
    items: [],
  });
  await softDelete('meals', 'deleted-meal');
  await put('apiCache', {
    id: 'search_private-query',
    source: 'openfoodfacts',
    query: 'private query',
  });

  const backup = await exportAllData();
  assert.equal(backup.version, BACKUP_SCHEMA_VERSION);
  assert.equal(backup.dataVersion, DATA_SCHEMA_VERSION);
  assert.equal(backup.secretsExcluded, true);
  assert.equal(backup.stores.settings.some(record => record.key === 'ai_api_key'), false);
  assert.equal(Object.hasOwn(backup.stores, 'apiCache'), false);
  assert.equal(backup.stores.meals.some(record => record.id === 'deleted-meal'), false);

  await clearAllData();
  await setSetting('ai_api_key', 'replacement-profile-secret');
  await importAllData(backup);

  assert.deepEqual((await getAll('foods')).map(record => record.id), ['roundtrip-food']);
  assert.deepEqual((await getAll('meals')).map(record => record.id), ['roundtrip-meal']);
  assert.equal(await getSetting('theme'), 'lauds');
  assert.equal(await getSetting('ai_api_key'), 'replacement-profile-secret');
  assert.deepEqual(await getAll('apiCache'), []);
});

test('merge keeps local conflicts and adds new imported records', async () => {
  await clearAllData();
  const foodShape = {
    servingSize: { quantity: 100, unit: 'g' },
    nutrients: {
      energy: { kcal: 100 },
      macros: { protein: { g: 1 }, carbs: { g: 2 }, fat: { g: 3 } },
      fiber: { g: null },
      sodium: { mg: null },
    },
  };
  await put('foods', { id: 'same-id', name: 'Local food', ...foodShape });
  await setSetting('theme', 'vigil');

  await importAllData({
    version: BACKUP_SCHEMA_VERSION,
    stores: {
      foods: [
        { id: 'same-id', name: 'Imported conflict', ...foodShape },
        { id: 'new-id', name: 'Imported new food', ...foodShape },
      ],
      settings: [{ key: 'theme', value: 'lauds' }],
    },
  }, true);

  const foods = await getAll('foods');
  assert.equal(foods.find(food => food.id === 'same-id').name, 'Local food');
  assert.equal(foods.find(food => food.id === 'new-id').name, 'Imported new food');
  assert.equal(await getSetting('theme'), 'vigil');
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
