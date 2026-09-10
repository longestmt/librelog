import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  BACKUP_SCHEMA_VERSION,
  clearAllData,
  deleteAllSynchronizedData,
  getAll,
  hardDeleteAll,
  importAllData,
  openDB,
  put,
  setSetting,
} from '../src/data/db.js';
import { createMeal } from '../src/data/meal-commands.js';
import { saveRecipeWithFoods } from '../src/data/recipe-commands.js';
import {
  getOrCreateSyncDeviceId,
  SYNC_STORE_NAMES,
} from '../src/sync/atomic.js';
import {
  disconnectLibreSync,
  getLibreSyncClient,
} from '../src/sync/service.js';

function request(requestValue) {
  return new Promise((resolve, reject) => {
    requestValue.onsuccess = () => resolve(requestValue.result);
    requestValue.onerror = () => reject(requestValue.error);
  });
}

async function allFrom(storeName) {
  const database = await openDB();
  return request(database.transaction(storeName).objectStore(storeName).getAll());
}

async function enableRecording(deviceId = 'test-device') {
  const database = await openDB();
  const transaction = database.transaction(SYNC_STORE_NAMES.state, 'readwrite');
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  transaction.objectStore(SYNC_STORE_NAMES.state).put({
    key: 'connection',
    value: {
      protocolVersion: 1,
      applicationId: 'org.libresuite.librelog',
      serverUrl: 'http://localhost:8787',
      vaultId: 'test-vault',
      deviceId,
      deviceLabel: 'Test device',
      connectedAt: '2026-09-01T00:00:00.000Z',
    },
  });
  await completion;
}

const foodShape = {
  servingSize: { quantity: 1, unit: 'serving', aliases: [] },
  nutrients: {
    energy: { kcal: 100 },
    macros: { protein: { g: 1 }, carbs: { g: 2 }, fat: { g: 3 } },
    fiber: { g: null },
    sodium: { mg: null },
  },
};

test('ordinary synchronized writes atomically create causal outbox state', async () => {
  await clearAllData();
  await enableRecording();
  await put('foods', { id: 'atomic-outbox-food', name: 'Atomic outbox food', ...foodShape });

  const outbox = await allFrom(SYNC_STORE_NAMES.outbox);
  const heads = await allFrom(SYNC_STORE_NAMES.entityHeads);
  const state = await allFrom(SYNC_STORE_NAMES.state);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].status, 'pending');
  assert.equal(outbox[0].operation.changes[0].entityId, 'atomic-outbox-food');
  assert.equal(heads.some(record => record.entityId === 'atomic-outbox-food'), true);
  assert.equal(state.some(record => String(record.key).startsWith('deviceCounter:')), true);
});

test('writes before consent or connection stay local for later bootstrap', async () => {
  await clearAllData();
  await put('foods', { id: 'pre-vault-food', name: 'Pre-vault food', ...foodShape });
  assert.equal((await getAll('foods')).length, 1);
  assert.deepEqual(await allFrom(SYNC_STORE_NAMES.outbox), []);
  assert.deepEqual(await allFrom(SYNC_STORE_NAMES.entityHeads), []);
});

test('disconnect rotates one stable identity used by service, recorder, and reload', async () => {
  await clearAllData();
  const database = await openDB();
  const firstDeviceId = await getOrCreateSyncDeviceId(database);
  await enableRecording(firstDeviceId);
  assert.equal((await getLibreSyncClient().then(client => client.getStatus())).deviceId, firstDeviceId);

  await disconnectLibreSync();
  const secondDeviceId = await getOrCreateSyncDeviceId(database);
  assert.notEqual(secondDeviceId, firstDeviceId, 'a disconnected relay device ID is not reused');

  await enableRecording(secondDeviceId);
  await put('foods', { id: 'post-reconnect-food', name: 'Post-reconnect food', ...foodShape });
  const [pending] = await allFrom(SYNC_STORE_NAMES.outbox);
  assert.equal(pending.operation.dot.deviceId, secondDeviceId, 'atomic recorder uses rotated ID');
  assert.equal(
    (await getLibreSyncClient().then(client => client.getStatus())).deviceId,
    secondDeviceId,
    'new service instance uses rotated ID',
  );
  assert.equal(
    await getOrCreateSyncDeviceId(database),
    secondDeviceId,
    'durable local-only ID survives a reload-style lookup',
  );
});

test('local-only settings and API cache never enter the outbox', async () => {
  await clearAllData();
  await setSetting('ai_api_key', 'local secret sentinel');
  await setSetting('privacyConsent_usda', true);
  await put('apiCache', { id: 'private-query', query: 'local search sentinel' });
  assert.deepEqual(await allFrom(SYNC_STORE_NAMES.outbox), []);
  await hardDeleteAll('apiCache');
  assert.deepEqual(await allFrom('apiCache'), []);
  await assert.rejects(() => hardDeleteAll('foods'), /local-only API cache/);
});

test('new food and referencing meal share one causal operation', async () => {
  await clearAllData();
  await enableRecording();
  const food = { id: 'atomic-related-food', name: 'Related food', ...foodShape };
  await createMeal({
    date: '2026-09-01',
    type: 'lunch',
    items: [{ foodId: food.id, quantity: 1, unit: 'serving' }],
  }, { idempotencyKey: 'atomic-related-meal', relatedFoods: [food] });

  const outbox = await allFrom(SYNC_STORE_NAMES.outbox);
  assert.equal(outbox.length, 1);
  assert.deepEqual(
    new Set(outbox[0].operation.changes.map(change => change.entityType)),
    new Set(['foods', 'meals']),
  );
});

test('new ingredient food and its recipe share one causal operation', async () => {
  await clearAllData();
  await enableRecording();
  const food = { id: 'atomic-recipe-food', name: 'Recipe ingredient', ...foodShape };
  await saveRecipeWithFoods({
    id: 'atomic-recipe',
    name: 'Atomic recipe',
    servings: 1,
    items: [{ itemId: crypto.randomUUID(), foodId: food.id, quantity: 1, unit: 'serving' }],
  }, [food]);

  const outbox = await allFrom(SYNC_STORE_NAMES.outbox);
  assert.equal(outbox.length, 1);
  assert.deepEqual(
    new Set(outbox[0].operation.changes.map(change => change.entityType)),
    new Set(['foods', 'recipes']),
  );
});

test('large replacement restores remain atomic while chunking protocol operations', async () => {
  await clearAllData();
  await enableRecording();
  const foods = Array.from({ length: 401 }, (_, index) => ({
    id: `bulk-food-${index}`,
    name: `Bulk food ${index}`,
    ...foodShape,
  }));
  await importAllData({
    version: BACKUP_SCHEMA_VERSION,
    stores: { foods },
  }, false);

  assert.equal((await getAll('foods')).length, 401);
  const outbox = (await allFrom(SYNC_STORE_NAMES.outbox))
    .sort((a, b) => a.operation.dot.counter - b.operation.dot.counter);
  assert.deepEqual(outbox.map(record => record.operation.changes.length), [200, 200, 1]);
});

test('delete-everywhere tombstones synchronized data but retains local-only state', async () => {
  await clearAllData();
  await enableRecording();
  await put('foods', { id: 'delete-food', name: 'Delete food', ...foodShape });
  await setSetting('theme', 'lauds');
  await setSetting('ai_api_key', 'keep-on-device');
  const before = (await allFrom(SYNC_STORE_NAMES.outbox)).length;

  const deleted = await deleteAllSynchronizedData();
  assert.equal(deleted, 2);
  assert.deepEqual(await getAll('foods'), []);
  assert.equal((await allFrom('foods'))[0].deleted, true);
  assert.equal(await allFrom('settings').then(records => (
    records.find(record => record.key === 'ai_api_key')?.value
  )), 'keep-on-device');
  const outbox = (await allFrom(SYNC_STORE_NAMES.outbox))
    .sort((a, b) => a.operation.dot.counter - b.operation.dot.counter);
  assert.equal(outbox.length, before + 1);
  assert.deepEqual(
    new Set(outbox.at(-1).operation.changes.map(change => `${change.entityType}:${change.kind}`)),
    new Set(['foods:delete', 'settings:delete']),
  );
});
