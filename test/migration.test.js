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

async function createVersionTwoDatabase() {
  const request = indexedDB.open('librelog', 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('foods', { keyPath: 'id' });
    const meals = db.createObjectStore('meals', { keyPath: 'id' });
    meals.createIndex('date', 'date', { unique: false });
    meals.createIndex('mealType', 'mealType', { unique: false });
    meals.createIndex('idempotencyKey', 'idempotencyKey', { unique: false });
    db.createObjectStore('recipes', { keyPath: 'id' });
    db.createObjectStore('measurements', { keyPath: 'id' });
    db.createObjectStore('settings', { keyPath: 'key' });
    db.createObjectStore('apiCache', { keyPath: 'id' });
  };
  const db = await requestResult(request);
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['foods', 'meals', 'settings'], 'readwrite');
    transaction.objectStore('foods').put({
      id: 'legacy-food',
      name: 'Legacy food',
      servingSize: { quantity: 1, unit: 'serving' },
      nutrients: {
        energy: { kcal: 100 },
        macros: { protein: { g: 1 }, carbs: { g: 2 }, fat: { g: 3 } },
        fiber: { g: null },
        sodium: { mg: null },
      },
    });
    transaction.objectStore('meals').put({
      id: 'legacy-meal',
      date: '2026-07-26',
      type: 'dinner',
      items: [{ foodId: 'legacy-food', quantity: 1, unit: 'serving' }],
    });
    transaction.objectStore('settings').put({ key: 'theme', value: 'lauds' });
    transaction.objectStore('settings').put({ key: 'ai_api_key', value: 'must-not-leave-profile' });
    transaction.objectStore('settings').put({ key: 'privacyConsent_openfoodfacts', value: true });
    transaction.objectStore('settings').put({ key: 'ai_ollama_url', value: 'https://legacy.example.com' });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function deleteDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('librelog');
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database deletion was blocked'));
  });
}

test('version 3 checkpoints data, assigns stable meal-item IDs, and supports rollback', async () => {
  await createVersionTwoDatabase();
  const database = await import(`../src/data/db.js?migration=${Date.now()}`);
  const db = await database.openDB();

  assert.equal(db.version, 3);
  const transaction = db.transaction('meals', 'readonly');
  assert.equal(transaction.objectStore('meals').indexNames.contains('idempotencyKey'), true);

  const checkpoints = database.getMigrationBackups();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].fromVersion, 2);
  assert.equal(checkpoints[0].toVersion, 3);

  const checkpoint = database.getMigrationBackupData(checkpoints[0].timestamp);
  assert.equal(checkpoint.secretsExcluded, true);
  assert.equal(checkpoint.stores.settings.some(record => record.key === 'ai_api_key'), false);
  assert.equal(checkpoint.stores.settings.some(record => record.key.startsWith('privacyConsent_')), false);
  assert.equal(checkpoint.stores.settings.some(record => record.key === 'ai_ollama_url'), false);
  assert.equal(checkpoint.stores.meals[0].id, 'legacy-meal');
  assert.equal(checkpoint.stores.meals[0].items[0].itemId, undefined);

  const upgradedMeal = (await database.getAll('meals'))[0];
  assert.equal(typeof upgradedMeal.items[0].itemId, 'string');

  await database.put('meals', {
    id: 'later-meal',
    date: '2026-07-27',
    type: 'lunch',
    items: [{ foodId: 'legacy-food', quantity: 2, unit: 'serving' }],
  });
  await database.importAllData(checkpoint, false);

  assert.deepEqual((await database.getAll('meals')).map(meal => meal.id), ['legacy-meal']);
  assert.equal(typeof (await database.getAll('meals'))[0].items[0].itemId, 'string');
  assert.equal(await database.getSetting('theme'), 'lauds');
  db.close();
});

test('version 3 still upgrades atomically when migration checkpoint storage is unavailable', async () => {
  await deleteDatabase();
  storage.clear();
  await createVersionTwoDatabase();
  const originalSetItem = globalThis.localStorage.setItem;
  const originalWarn = console.warn;
  globalThis.localStorage.setItem = () => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  };
  console.warn = () => {};

  try {
    const database = await import(`../src/data/db.js?quota-migration=${Date.now()}`);
    const db = await database.openDB();
    assert.equal(db.version, 3);
    const [upgradedMeal] = await database.getAll('meals');
    assert.equal(upgradedMeal.id, 'legacy-meal');
    assert.equal(typeof upgradedMeal.items[0].itemId, 'string');
    assert.deepEqual(database.getMigrationBackups(), []);
    db.close();
  } finally {
    globalThis.localStorage.setItem = originalSetItem;
    console.warn = originalWarn;
  }
});
