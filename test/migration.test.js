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

async function createVersionThreeDatabase() {
  const request = indexedDB.open('librelog', 3);
  request.onupgradeneeded = () => {
    const db = request.result;
    const foods = db.createObjectStore('foods', { keyPath: 'id' });
    foods.createIndex('name', 'name', { unique: false });
    foods.createIndex('barcode', 'barcode', { unique: false });
    foods.createIndex('source', 'source', { unique: false });
    const meals = db.createObjectStore('meals', { keyPath: 'id' });
    meals.createIndex('date', 'date', { unique: false });
    meals.createIndex('mealType', 'mealType', { unique: false });
    meals.createIndex('idempotencyKey', 'idempotencyKey', { unique: false });
    const recipes = db.createObjectStore('recipes', { keyPath: 'id' });
    recipes.createIndex('name', 'name', { unique: false });
    recipes.createIndex('category', 'category', { unique: false });
    const measurements = db.createObjectStore('measurements', { keyPath: 'id' });
    measurements.createIndex('date', 'date', { unique: false });
    db.createObjectStore('settings', { keyPath: 'key' });
    const apiCache = db.createObjectStore('apiCache', { keyPath: 'id' });
    apiCache.createIndex('source', 'source', { unique: false });
    apiCache.createIndex('query', 'query', { unique: false });
    apiCache.createIndex('expiresAt', 'expiresAt', { unique: false });
  };
  const db = await requestResult(request);
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['foods', 'meals', 'recipes', 'settings', 'apiCache'], 'readwrite');
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
    transaction.objectStore('foods').put({
      id: 'random-seed-id',
      name: 'Egg, large',
      servingSize: { quantity: 1, unit: 'large', gramsPerUnit: 50 },
      nutrients: {
        energy: { kcal: 70 },
        macros: { protein: { g: 6 }, carbs: { g: 0.5 }, fat: { g: 5 } },
        fiber: { g: 0 },
        sodium: { mg: 71 },
      },
      source: { type: 'seed' },
    });
    transaction.objectStore('meals').put({
      id: 'legacy-meal',
      date: '2026-07-26',
      type: 'dinner',
      items: [
        {
          itemId: 'shipped-v3-meal-item',
          foodId: 'legacy-food',
          quantity: 1,
          unit: 'serving',
        },
        {
          itemId: 'shipped-v3-seed-item',
          foodId: 'random-seed-id',
          quantity: 1,
          unit: 'large',
        },
      ],
    });
    transaction.objectStore('recipes').put({
      id: 'legacy-recipe',
      name: 'Legacy recipe',
      servings: 1,
      items: [{ foodId: 'random-seed-id', quantity: 1, unit: 'large' }],
    });
    transaction.objectStore('settings').put({ key: 'theme', value: 'lauds' });
    transaction.objectStore('settings').put({
      key: 'template_legacy',
      value: {
        name: 'Legacy template',
        items: [{ foodId: 'random-seed-id', quantity: 1, unit: 'large' }],
      },
    });
    transaction.objectStore('settings').put({ key: 'ai_api_key', value: 'must-not-leave-profile' });
    transaction.objectStore('settings').put({ key: 'privacyConsent_openfoodfacts', value: true });
    transaction.objectStore('settings').put({ key: 'ai_ollama_url', value: 'https://legacy.example.com' });
    transaction.objectStore('apiCache').put({
      id: 'private-search-cache',
      query: 'must-not-enter-migration-backup',
    });
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

test('version 4 upgrades a shipped version-3 database without replacing stable child IDs', async () => {
  await createVersionThreeDatabase();
  const database = await import(`../src/data/db.js?migration=${Date.now()}`);
  const db = await database.openDB();

  assert.equal(db.version, 4);
  const transaction = db.transaction('meals', 'readonly');
  assert.equal(transaction.objectStore('meals').indexNames.contains('idempotencyKey'), true);
  assert.equal(transaction.objectStore('meals').indexNames.contains('type'), true);
  assert.equal(transaction.objectStore('meals').indexNames.contains('mealType'), false);
  for (const storeName of [
    'libresync_outbox',
    'libresync_inbox',
    'libresync_entity_heads',
    'libresync_conflicts',
    'libresync_state',
  ]) {
    assert.equal(db.objectStoreNames.contains(storeName), true, storeName);
  }

  const checkpoints = database.getMigrationBackups();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].fromVersion, 3);
  assert.equal(checkpoints[0].toVersion, 4);

  const checkpoint = database.getMigrationBackupData(checkpoints[0].timestamp);
  assert.equal(checkpoint.secretsExcluded, true);
  assert.equal(checkpoint.stores.settings.some(record => record.key === 'ai_api_key'), false);
  assert.equal(checkpoint.stores.settings.some(record => record.key.startsWith('privacyConsent_')), false);
  assert.equal(checkpoint.stores.settings.some(record => record.key === 'ai_ollama_url'), false);
  assert.equal(Object.hasOwn(checkpoint.stores, 'apiCache'), false);
  assert.equal(JSON.stringify(checkpoint).includes('must-not-enter-migration-backup'), false);
  assert.equal(checkpoint.stores.meals[0].id, 'legacy-meal');
  assert.equal(checkpoint.stores.meals[0].items[0].itemId, 'shipped-v3-meal-item');

  const upgradedMeal = (await database.getAll('meals'))[0];
  assert.equal(upgradedMeal.items[0].itemId, 'shipped-v3-meal-item');

  const seedId = 'librelog:food:seed:v1:egg-large';
  const foods = await database.getAll('foods');
  assert.equal(foods.some(food => food.id === 'random-seed-id'), false);
  assert.equal(foods.some(food => food.id === seedId), true);
  const migratedMeal = await database.getById('meals', 'legacy-meal');
  assert.equal(migratedMeal.items[1].foodId, seedId);
  assert.equal(migratedMeal.items[0].itemId, 'shipped-v3-meal-item');
  assert.equal(migratedMeal.items[1].itemId, 'shipped-v3-seed-item');
  const migratedRecipe = await database.getById('recipes', 'legacy-recipe');
  assert.equal(migratedRecipe.items[0].foodId, seedId);
  assert.match(migratedRecipe.items[0].itemId, /^legacy-recipe:item:v1:/);
  const migratedTemplate = await database.getSetting('template_legacy');
  assert.equal(migratedTemplate.items[0].foodId, seedId);
  assert.match(migratedTemplate.items[0].itemId, /^template_legacy:item:v1:/);

  await database.put('meals', {
    id: 'later-meal',
    date: '2026-07-27',
    type: 'lunch',
    items: [{ foodId: 'legacy-food', quantity: 2, unit: 'serving' }],
  });
  await database.importAllData(checkpoint, false);

  assert.deepEqual((await database.getAll('meals')).map(meal => meal.id), ['legacy-meal']);
  assert.equal(
    (await database.getAll('meals'))[0].items[0].itemId,
    'shipped-v3-meal-item',
  );
  assert.equal(await database.getSetting('theme'), 'lauds');
  db.close();
});

test('version 4 still upgrades atomically when migration checkpoint storage is unavailable', async () => {
  await deleteDatabase();
  storage.clear();
  await createVersionThreeDatabase();
  const originalSetItem = globalThis.localStorage.setItem;
  const originalWarn = console.warn;
  globalThis.localStorage.setItem = () => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  };
  console.warn = () => {};

  try {
    const database = await import(`../src/data/db.js?quota-migration=${Date.now()}`);
    const db = await database.openDB();
    assert.equal(db.version, 4);
    const [upgradedMeal] = await database.getAll('meals');
    assert.equal(upgradedMeal.id, 'legacy-meal');
    assert.equal(upgradedMeal.items[0].itemId, 'shipped-v3-meal-item');
    assert.deepEqual(database.getMigrationBackups(), []);
    db.close();
  } finally {
    globalThis.localStorage.setItem = originalSetItem;
    console.warn = originalWarn;
  }
});
