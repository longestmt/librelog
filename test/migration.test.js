import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  },
});

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function createVersionOneDatabase() {
  const request = indexedDB.open('librelog', 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('foods', { keyPath: 'id' });
    const meals = db.createObjectStore('meals', { keyPath: 'id' });
    meals.createIndex('date', 'date', { unique: false });
    meals.createIndex('mealType', 'mealType', { unique: false });
    db.createObjectStore('recipes', { keyPath: 'id' });
    db.createObjectStore('measurements', { keyPath: 'id' });
    db.createObjectStore('settings', { keyPath: 'key' });
    db.createObjectStore('apiCache', { keyPath: 'id' });
  };
  const db = await requestResult(request);
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['foods', 'meals', 'settings'], 'readwrite');
    transaction.objectStore('foods').put({ id: 'legacy-food', name: 'Legacy food' });
    transaction.objectStore('meals').put({
      id: 'legacy-meal',
      date: '2026-07-26',
      type: 'dinner',
      items: [{ foodId: 'legacy-food', quantity: 1, unit: 'serving' }],
    });
    transaction.objectStore('settings').put({ key: 'theme', value: 'lauds' });
    transaction.objectStore('settings').put({ key: 'ai_api_key', value: 'must-not-leave-profile' });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

test('version 2 makes a credential-free checkpoint and supports rollback', async () => {
  await createVersionOneDatabase();
  const database = await import(`../src/data/db.js?migration=${Date.now()}`);
  const db = await database.openDB();

  assert.equal(db.version, 2);
  const transaction = db.transaction('meals', 'readonly');
  assert.equal(transaction.objectStore('meals').indexNames.contains('idempotencyKey'), true);

  const checkpoints = database.getMigrationBackups();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].fromVersion, 1);
  assert.equal(checkpoints[0].toVersion, 2);

  const checkpoint = database.getMigrationBackupData(checkpoints[0].timestamp);
  assert.equal(checkpoint.secretsExcluded, true);
  assert.equal(checkpoint.stores.settings.some(record => record.key === 'ai_api_key'), false);
  assert.equal(checkpoint.stores.meals[0].id, 'legacy-meal');

  await database.put('meals', {
    id: 'later-meal',
    date: '2026-07-27',
    type: 'lunch',
    items: [{ foodId: 'legacy-food', quantity: 2, unit: 'serving' }],
  });
  await database.importAllData(checkpoint, false);

  assert.deepEqual((await database.getAll('meals')).map(meal => meal.id), ['legacy-meal']);
  assert.equal(await database.getSetting('theme'), 'lauds');
  db.close();
});
