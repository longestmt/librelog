import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { applyLibreLogMaterialized } from '../src/sync/domain-adapter.js';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('aborted'));
  });
}

async function createDatabase(name) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    for (const store of ['foods', 'meals', 'recipes', 'measurements']) {
      request.result.createObjectStore(store, { keyPath: 'id' });
    }
    request.result.createObjectStore('settings', { keyPath: 'key' });
    request.result.createObjectStore('libresync_outbox', { keyPath: 'opId' });
  };
  return requestResult(request);
}

function validFood(id, name = 'Remote food') {
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

test('remote multi-entity apply is atomic and creates no outbox echo', async () => {
  const db = await createDatabase(`adapter-${crypto.randomUUID()}`);
  const transaction = db.transaction(['foods', 'meals', 'libresync_outbox'], 'readwrite');
  applyLibreLogMaterialized({
    transaction,
    source: 'remote',
    operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
    entities: [
      { entityType: 'foods', entityId: 'food-a', kind: 'put', payload: validFood('food-a') },
      { entityType: 'meals', entityId: 'meal-a', kind: 'put', payload: {
        id: 'meal-a',
        date: '2026-09-01',
        type: 'lunch',
        items: [{ itemId: 'item-a', foodId: 'food-a', quantity: 1, unit: 'serving' }],
      } },
    ],
  });
  await transactionDone(transaction);
  assert.equal((await requestResult(db.transaction('foods').objectStore('foods').get('food-a'))).name, 'Remote food');
  assert.equal((await requestResult(db.transaction('meals').objectStore('meals').get('meal-a'))).items[0].foodId, 'food-a');
  assert.equal((await requestResult(db.transaction('libresync_outbox').objectStore('libresync_outbox').count())), 0);
  db.close();
});

test('one remote-mutation event is emitted after each committed apply transaction', async () => {
  const originalWindow = globalThis.window;
  const windowTarget = new EventTarget();
  const events = [];
  windowTarget.addEventListener('librelog:remote-mutation', event => events.push(event.detail));
  globalThis.window = windowTarget;

  const db = await createDatabase(`adapter-notification-${crypto.randomUUID()}`);
  try {
    const transaction = db.transaction(['foods', 'recipes'], 'readwrite');
    applyLibreLogMaterialized({
      transaction,
      source: 'remote',
      operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
      entities: [{
        entityType: 'foods',
        entityId: 'food-notification',
        kind: 'put',
        payload: validFood('food-notification'),
      }],
    });
    applyLibreLogMaterialized({
      transaction,
      source: 'reconcile',
      operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
      entities: [{
        entityType: 'recipes',
        entityId: 'recipe-notification',
        kind: 'put',
        payload: { id: 'recipe-notification', name: 'Remote recipe', items: [] },
      }],
    });
    assert.deepEqual(events, []);
    await transactionDone(transaction);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'mixed');
    assert.deepEqual(events[0].sources, ['reconcile', 'remote']);
    assert.deepEqual(events[0].entities, [
      { entityType: 'foods', entityId: 'food-notification' },
      { entityType: 'recipes', entityId: 'recipe-notification' },
    ]);

    const abortedTransaction = db.transaction('foods', 'readwrite');
    const abortedCompletion = transactionDone(abortedTransaction);
    applyLibreLogMaterialized({
      transaction: abortedTransaction,
      source: 'remote',
      operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
      entities: [{
        entityType: 'foods',
        entityId: 'food-aborted-notification',
        kind: 'put',
        payload: validFood('food-aborted-notification'),
      }],
    });
    abortedTransaction.abort();
    await assert.rejects(abortedCompletion);
    assert.equal(events.length, 1);
  } finally {
    db.close();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('malformed second entity writes nothing and leaves room for client quarantine', async () => {
  const db = await createDatabase(`adapter-abort-${crypto.randomUUID()}`);
  const transaction = db.transaction(['foods', 'meals'], 'readwrite');
  assert.throws(() => applyLibreLogMaterialized({
    transaction,
    source: 'remote',
    operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
    entities: [
      { entityType: 'foods', entityId: 'food-a', kind: 'put', payload: validFood('food-a', 'Must roll back') },
      { entityType: 'meals', entityId: 'meal-a', kind: 'put', payload: { id: 'wrong-id', items: [] } },
    ],
  }), /identity/i);
  await transactionDone(transaction);
  assert.equal(await requestResult(db.transaction('foods').objectStore('foods').get('food-a')), undefined);
  db.close();
});

test('malformed foods and duplicate stable child IDs are rejected before writes', async () => {
  const db = await createDatabase(`adapter-validation-${crypto.randomUUID()}`);

  const malformedFoodTx = db.transaction('foods', 'readwrite');
  assert.throws(() => applyLibreLogMaterialized({
    transaction: malformedFoodTx,
    source: 'remote',
    operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
    entities: [{
      entityType: 'foods',
      entityId: 'food-malformed',
      kind: 'put',
      payload: { id: 'food-malformed', name: 'Missing nutrition and serving size' },
    }],
  }), /serving|nutrition/i);
  await transactionDone(malformedFoodTx);
  assert.equal(await requestResult(db.transaction('foods').objectStore('foods').get('food-malformed')), undefined);

  const duplicateItemTx = db.transaction('meals', 'readwrite');
  assert.throws(() => applyLibreLogMaterialized({
    transaction: duplicateItemTx,
    source: 'remote',
    operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
    entities: [{
      entityType: 'meals',
      entityId: 'meal-duplicates',
      kind: 'put',
      payload: {
        id: 'meal-duplicates',
        date: '2026-09-01',
        type: 'lunch',
        items: [
          { itemId: 'duplicate', foodId: 'food-a', quantity: 1, unit: 'serving' },
          { itemId: 'duplicate', foodId: 'food-b', quantity: 1, unit: 'serving' },
        ],
      },
    }],
  }), /duplicate child item ids/i);
  await transactionDone(duplicateItemTx);
  assert.equal(await requestResult(db.transaction('meals').objectStore('meals').get('meal-duplicates')), undefined);
  db.close();
});

test('same-date measurements with different UUIDs remain distinct', async () => {
  const db = await createDatabase(`adapter-weight-${crypto.randomUUID()}`);
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const transaction = db.transaction('measurements', 'readwrite');
  applyLibreLogMaterialized({
    transaction,
    source: 'remote',
    operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
    entities: [firstId, secondId].map((id, index) => ({
      entityType: 'measurements',
      entityId: id,
      kind: 'put',
      payload: { id, date: '2026-09-01', weight: 80 + index, unit: 'kg' },
    })),
  });
  await transactionDone(transaction);
  const records = await requestResult(db.transaction('measurements').objectStore('measurements').getAll());
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map(record => record.id)), new Set([firstId, secondId]));
  db.close();
});

test('recipe completeness synchronizes as a bounded nutrient-key list', async () => {
  const db = await createDatabase(`adapter-recipe-${crypto.randomUUID()}`);
  const recipe = {
    id: 'recipe-incomplete',
    name: 'Partially known recipe',
    servings: 2,
    items: [{ itemId: 'ingredient-a', foodId: 'food-a', quantity: 1, unit: 'serving' }],
    nutritionPerServing: {
      kcal: 100,
      protein: null,
      carbs: 10,
      fat: 2,
      fiber: null,
      incomplete: ['protein', 'fiber'],
    },
  };
  const transaction = db.transaction('recipes', 'readwrite');
  applyLibreLogMaterialized({
    transaction,
    source: 'remote',
    operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
    entities: [{
      entityType: 'recipes',
      entityId: recipe.id,
      kind: 'put',
      payload: recipe,
    }],
  });
  await transactionDone(transaction);
  assert.deepEqual(
    (await requestResult(db.transaction('recipes').objectStore('recipes').get(recipe.id)))
      .nutritionPerServing.incomplete,
    ['protein', 'fiber'],
  );

  const invalidTransaction = db.transaction('recipes', 'readwrite');
  assert.throws(() => applyLibreLogMaterialized({
    transaction: invalidTransaction,
    source: 'remote',
    operation: { authoredAt: '2026-09-01T12:00:00.000Z' },
    entities: [{
      entityType: 'recipes',
      entityId: 'recipe-invalid-incomplete',
      kind: 'put',
      payload: {
        ...recipe,
        id: 'recipe-invalid-incomplete',
        nutritionPerServing: { ...recipe.nutritionPerServing, incomplete: ['unknown'] },
      },
    }],
  }), /completeness list/i);
  await transactionDone(invalidTransaction);
  db.close();
});
