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
  await setSetting('ai_provider', 'openai');
  await setSetting('ai_api_key', 'must-stay-local');
  await setSetting('ai_api_key_provider', 'openai');
  await setSetting('privacyConsent_openfoodfacts', true);
  await setSetting('privacyConsent_webdav', true);
  await setSetting('ai_model', 'private-model-choice');
  await setSetting('ai_ollama_url', 'http://localhost:11434');
  await setSetting('privacyConsent_usda', true);
  await setSetting('ai_usage_log', [{ date: '2026-07-01', tokens: 12 }]);
  await setSetting('initialized', true);
  await setSetting('libresync_deviceId', 'local-sync-device-id');
  await setSetting('lastBackupTime', 1234);
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
  assert.equal(backup.stores.settings.some(record => record.key === 'ai_api_key_provider'), false);
  assert.equal(backup.stores.settings.some(record => record.key.startsWith('privacyConsent_')), false);
  assert.equal(backup.stores.settings.some(record => record.key === 'libresync_deviceId'), false);
  const portableSettings = new Map(
    backup.stores.settings.map(record => [record.key, record.value]),
  );
  assert.equal(portableSettings.get('ai_provider'), 'openai');
  assert.equal(portableSettings.get('ai_model'), 'private-model-choice');
  assert.equal(portableSettings.get('ai_ollama_url'), 'http://localhost:11434');
  assert.deepEqual(portableSettings.get('ai_usage_log'), [{ date: '2026-07-01', tokens: 12 }]);
  assert.equal(portableSettings.get('initialized'), true);
  assert.equal(portableSettings.get('lastBackupTime'), 1234);
  assert.equal(Object.hasOwn(backup.stores, 'apiCache'), false);
  assert.equal(backup.stores.meals.some(record => record.id === 'deleted-meal'), false);

  // A legacy or hand-edited backup cannot grant disclosure consent or restore
  // an Ollama endpoint outside the local device.
  backup.stores.settings.find(record => record.key === 'ai_ollama_url').value =
    'https://ollama.example.com';
  backup.stores.settings.push({ key: 'privacyConsent_usda', value: true });

  await clearAllData();
  await setSetting('ai_api_key', 'replacement-profile-secret');
  await setSetting('ai_api_key_provider', 'openai');
  await setSetting('privacyConsent_browser_speech', true);
  await setSetting('privacyConsent_webdav', true);
  await setSetting('ai_provider', 'ollama');
  await importAllData(backup);

  assert.deepEqual((await getAll('foods')).map(record => record.id), ['roundtrip-food']);
  assert.deepEqual((await getAll('meals')).map(record => record.id), ['roundtrip-meal']);
  assert.equal(await getSetting('theme'), 'lauds');
  assert.equal(await getSetting('ai_api_key'), 'replacement-profile-secret');
  assert.equal(await getSetting('privacyConsent_openfoodfacts', false), false);
  assert.equal(await getSetting('privacyConsent_usda', false), false);
  assert.equal(await getSetting('privacyConsent_browser_speech', false), false);
  assert.equal(await getSetting('privacyConsent_webdav', false), true);
  assert.equal(await getSetting('ai_ollama_url'), null);
  assert.equal(await getSetting('ai_provider'), 'openai');
  assert.equal(await getSetting('ai_model'), 'private-model-choice');
  assert.deepEqual(await getSetting('ai_usage_log'), [{ date: '2026-07-01', tokens: 12 }]);
  assert.equal(await getSetting('initialized'), true);
  assert.equal(await getSetting('lastBackupTime'), 1234);
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

test('a partial replacement clears every portable store and keeps local secrets', async () => {
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
  await put('foods', { id: 'old-food', name: 'Old food', ...foodShape });
  await put('meals', {
    id: 'old-meal',
    date: '2026-09-09',
    type: 'lunch',
    items: [{ foodId: 'old-food', quantity: 100, unit: 'g' }],
  });
  await put('recipes', { id: 'old-recipe', name: 'Old recipe', servings: 1, items: [] });
  await put('measurements', { id: 'old-weight', date: '2026-09-09', weight: 70, unit: 'kg' });
  await setSetting('theme', 'vigil');
  await setSetting('usda_api_key', 'device-only-secret');

  await importAllData({
    version: BACKUP_SCHEMA_VERSION,
    stores: {
      foods: [{ id: 'new-food', name: 'New food', ...foodShape }],
    },
  }, false);

  assert.deepEqual((await getAll('foods')).map(food => food.id), ['new-food']);
  assert.deepEqual(await getAll('meals'), []);
  assert.deepEqual(await getAll('recipes'), []);
  assert.deepEqual(await getAll('measurements'), []);
  assert.equal(await getSetting('theme', null), null);
  assert.equal(await getSetting('usda_api_key'), 'device-only-secret');
});

test('replace import leaves an ambiguous legacy AI key unusable', async () => {
  await clearAllData();
  await setSetting('ai_provider', 'openai');
  await setSetting('ai_api_key', 'legacy-openai-key');

  await importAllData({
    version: BACKUP_SCHEMA_VERSION,
    stores: {
      settings: [{ key: 'ai_provider', value: 'anthropic' }],
    },
  });

  assert.equal(await getSetting('ai_api_key'), 'legacy-openai-key');
  assert.equal(await getSetting('ai_api_key_provider'), null);
  assert.equal(await getSetting('ai_provider'), 'anthropic');
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
