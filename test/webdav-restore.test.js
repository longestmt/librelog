import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  BACKUP_SCHEMA_VERSION,
  DATA_SCHEMA_VERSION,
  clearAllData,
  getAll,
  getSetting,
  put,
  setSetting,
} from '../src/data/db.js';
import { pullFromWebDav, saveWebDavConfigSafely } from '../src/data/webdav.js';

const browserStorage = new Map();
globalThis.localStorage = {
  getItem(key) {
    return browserStorage.has(key) ? browserStorage.get(key) : null;
  },
  setItem(key, value) {
    browserStorage.set(key, String(value));
  },
  removeItem(key) {
    browserStorage.delete(key);
  },
};

function food(id, name) {
  return {
    id,
    name,
    servingSize: { quantity: 1, unit: 'serving', aliases: [] },
    nutrients: {
      energy: { kcal: 100 },
      macros: { protein: { g: 1 }, carbs: { g: 2 }, fat: { g: 3 } },
      fiber: { g: null },
      sodium: { mg: null },
    },
  };
}

test('WebDAV restore performs the confirmed full-replacement diff and preserves credentials', async () => {
  await clearAllData();
  await put('foods', food('local-only-before-restore', 'Old local food'));
  await saveWebDavConfigSafely({
    url: 'https://backup.example.test/',
    username: 'backup-user',
    password: 'backup-password',
  });
  await setSetting('privacyConsent_webdav', true);

  const backup = {
    version: BACKUP_SCHEMA_VERSION,
    dataVersion: DATA_SCHEMA_VERSION,
    exportedAt: '2026-09-01T12:00:00.000Z',
    secretsExcluded: true,
    stores: { foods: [food('restored-food', 'Restored food')] },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(backup), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    assert.equal(await pullFromWebDav(), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual((await getAll('foods')).map(record => record.id), ['restored-food']);
  assert.equal(await getSetting('webdavUrl'), 'https://backup.example.test/');
  assert.equal(await getSetting('webdavUsername'), 'backup-user');
  assert.equal(await getSetting('webdavPassword'), 'backup-password');
  assert.equal(await getSetting('webdav_connected'), true);
  assert.equal(await getSetting('privacyConsent_webdav'), true);
});
