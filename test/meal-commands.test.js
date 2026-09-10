import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, getAll, getById, put, softDelete } from '../src/data/db.js';
import {
  copyMealsToDate,
  createMeal,
  createMealBatch,
  removeMealItem,
  restoreMealItem,
  updateMealItem,
  validateMealInput,
} from '../src/data/meal-commands.js';

const validMeal = {
  date: '2026-07-27',
  type: 'lunch',
  items: [{ foodId: 'food-1', quantity: 1, unit: 'serving' }],
};

test('a meal command uses one record for repeated idempotency keys', async () => {
  await clearAllData();
  const first = await createMeal(validMeal, { idempotencyKey: 'test:meal-command-0001' });
  const second = await createMeal(validMeal, { idempotencyKey: 'test:meal-command-0001' });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.meal.id, second.meal.id);
  assert.match(first.meal.id, /^[0-9a-f-]{36}$/i);
  assert.equal((await getAll('meals')).length, 1);
});

test('one command atomically stores related foods and one multi-item meal', async () => {
  await clearAllData();
  const foods = [
    { id: 'draft-food-1', name: 'Rice', servingSize: { quantity: 200, unit: 'g' } },
    { id: 'draft-food-2', name: 'Cheese', servingSize: { quantity: 28, unit: 'g' } },
  ];
  const input = {
    ...validMeal,
    items: [
      { foodId: foods[0].id, quantity: 100, unit: 'g', nutrients: { kcal: 130 } },
      { foodId: foods[1].id, quantity: 28, unit: 'g', nutrients: { kcal: 110 } },
    ],
  };

  const result = await createMeal(input, {
    idempotencyKey: 'test:mixed-draft-save-0001',
    relatedFoods: foods,
  });

  assert.equal(result.created, true);
  assert.equal((await getAll('meals')).length, 1);
  assert.equal(result.meal.items.length, 2);
  assert.equal(result.meal.items.every(item => typeof item.itemId === 'string'), true);
  assert.equal((await getById('foods', 'draft-food-1')).name, 'Rice');
  assert.equal((await getById('foods', 'draft-food-2')).name, 'Cheese');
});

test('invalid related food aborts before any part of a draft is written', async () => {
  await clearAllData();
  await assert.rejects(
    createMeal(validMeal, {
      idempotencyKey: 'test:mixed-draft-invalid-0001',
      relatedFoods: [{ id: 'valid-food', name: 'Valid' }, { name: 'Missing ID' }],
    }),
    /require an ID/i,
  );
  assert.equal((await getAll('foods')).length, 0);
  assert.equal((await getAll('meals')).length, 0);
});

test('draft save updates only explicit catalog preferences on an existing food', async () => {
  await clearAllData();
  await put('foods', {
    id: 'existing-food',
    name: 'Current catalog name',
    favorite: false,
    servingSize: { quantity: 100, unit: 'g' },
    nutrients: { energy: { kcal: 250 } },
  });

  await createMeal({
    ...validMeal,
    items: [{ foodId: 'existing-food', quantity: 2, unit: 'serving' }],
  }, {
    idempotencyKey: 'test:catalog-preferences-0001',
    relatedFoods: [{
      id: 'existing-food',
      name: 'Stale historical name',
      servingSize: { quantity: 1, unit: 'serving' },
      nutrients: { energy: { kcal: 100 } },
    }],
    catalogPreferences: [{
      foodId: 'existing-food',
      favorite: true,
      usualServing: { quantity: 2, unit: 'serving' },
    }],
  });

  const food = await getById('foods', 'existing-food');
  assert.equal(food.name, 'Current catalog name');
  assert.equal(food.nutrients.energy.kcal, 250);
  assert.equal(food.favorite, true);
  assert.deepEqual(food.usualServing, { quantity: 2, unit: 'serving' });
});

test('historical snapshots and preferences never resurrect a deleted food', async () => {
  await clearAllData();
  await put('foods', { id: 'deleted-food', name: 'Deleted food' });
  await softDelete('foods', 'deleted-food');

  await createMeal({
    ...validMeal,
    items: [{ foodId: 'deleted-food', quantity: 1, unit: 'serving' }],
  }, {
    idempotencyKey: 'test:deleted-catalog-food-0001',
    relatedFoods: [{ id: 'deleted-food', name: 'Old copy' }],
    catalogPreferences: [{ foodId: 'deleted-food', favorite: true }],
  });

  assert.equal(await getById('foods', 'deleted-food'), null);
  assert.equal((await getAll('meals')).length, 1);
});

test('a meal command rejects invalid dates, meal types, and quantities', () => {
  assert.throws(
    () => validateMealInput({ ...validMeal, date: '2026-02-30' }),
    /calendar date/i,
  );
  assert.throws(
    () => validateMealInput({ ...validMeal, type: 'brunch' }),
    /meal type/i,
  );
  assert.throws(
    () => validateMealInput({
      ...validMeal,
      items: [{ foodId: 'food-1', quantity: 0, unit: 'serving' }],
    }),
    /positive quantity/i,
  );
});

test('edit and remove commands apply each idempotency key one time', async () => {
  await clearAllData();
  const { meal } = await createMeal(validMeal, { idempotencyKey: 'test:meal-mutation-create' });
  const itemId = meal.items[0].itemId;
  assert.match(itemId, /^[0-9a-f-]{36}$/i);
  const changedItem = { ...validMeal.items[0], quantity: 2 };

  const firstEdit = await updateMealItem(meal.id, itemId, changedItem, {
    idempotencyKey: 'test:meal-mutation-edit',
  });
  const repeatedEdit = await updateMealItem(meal.id, itemId, changedItem, {
    idempotencyKey: 'test:meal-mutation-edit',
  });
  assert.equal(firstEdit.changed, true);
  assert.equal(repeatedEdit.changed, false);
  assert.equal(repeatedEdit.meal.items[0].quantity, 2);

  const firstRemove = await removeMealItem(meal.id, itemId, {
    idempotencyKey: 'test:meal-mutation-remove',
  });
  const repeatedRemove = await removeMealItem(meal.id, itemId, {
    idempotencyKey: 'test:meal-mutation-remove',
  });
  assert.equal(firstRemove.changed, true);
  assert.equal(repeatedRemove.changed, false);
  assert.equal((await getAll('meals')).length, 0);
});

test('copy commands do not duplicate a meal batch after a retry', async () => {
  await clearAllData();
  const sourceMeals = [
    validMeal,
    { ...validMeal, type: 'dinner' },
  ];
  await copyMealsToDate(sourceMeals, '2026-07-28', {
    idempotencyKey: 'test:copy-meal-batch',
  });
  await copyMealsToDate(sourceMeals, '2026-07-28', {
    idempotencyKey: 'test:copy-meal-batch',
  });

  const meals = await getAll('meals');
  assert.equal(meals.length, 2);
  assert.equal(meals.every(meal => meal.date === '2026-07-28'), true);
});

test('a meal batch validates atomically and never commits a valid prefix', async () => {
  await clearAllData();
  await assert.rejects(
    () => copyMealsToDate([
      validMeal,
      { ...validMeal, type: 'not-a-meal' },
    ], '2026-07-28', { idempotencyKey: 'test:atomic-copy-batch' }),
    /meal type/i,
  );
  assert.deepEqual(await getAll('meals'), []);
});

test('a meal import batch commits related foods and meals atomically', async () => {
  await clearAllData();
  await assert.rejects(
    createMealBatch([validMeal], {
      idempotencyKey: 'test:atomic-import-batch',
      relatedFoods: [
        { id: 'valid-food', name: 'Valid food' },
        { id: 'invalid-food', name: '' },
      ],
    }),
    /ID and name/i,
  );
  assert.deepEqual(await getAll('foods'), []);
  assert.deepEqual(await getAll('meals'), []);

  const results = await createMealBatch([validMeal], {
    idempotencyKey: 'test:atomic-import-batch',
    relatedFoods: [{ id: 'food-1', name: 'Imported food' }],
  });
  assert.equal(results[0].created, true);
  assert.equal((await getById('foods', 'food-1')).name, 'Imported food');
  assert.equal((await getAll('meals')).length, 1);
});

test('restoring one item never resurrects a separately removed sibling', async () => {
  await clearAllData();
  const firstItem = { ...validMeal.items[0], itemId: 'item-a' };
  const secondItem = { ...validMeal.items[0], foodId: 'food-2', itemId: 'item-b' };
  const { meal } = await createMeal({ ...validMeal, items: [firstItem, secondItem] }, {
    idempotencyKey: 'test:restore-create',
  });

  await removeMealItem(meal.id, 0, { idempotencyKey: 'test:restore-remove-a' });
  await removeMealItem(meal.id, 0, { idempotencyKey: 'test:restore-remove-b' });
  await restoreMealItem(meal.id, 0, firstItem, { idempotencyKey: 'test:restore-item-a' });
  const repeated = await restoreMealItem(meal.id, 0, firstItem, {
    idempotencyKey: 'test:restore-item-a',
  });

  const meals = await getAll('meals');
  assert.equal(meals.length, 1);
  assert.deepEqual(meals[0].items.map(item => item.itemId), ['item-a']);
  assert.equal(repeated.changed, false);
});

test('item commands follow item identity when a stale index shifts', async () => {
  await clearAllData();
  const firstItem = { ...validMeal.items[0], itemId: 'item-first' };
  const secondItem = { ...validMeal.items[0], foodId: 'food-second', itemId: 'item-second' };
  const { meal } = await createMeal({ ...validMeal, items: [firstItem, secondItem] }, {
    idempotencyKey: 'test:identity-create',
  });
  await removeMealItem(meal.id, 0, {
    idempotencyKey: 'test:identity-remove-first',
    expectedItemId: 'item-first',
  });
  await updateMealItem(meal.id, 1, { ...secondItem, quantity: 3 }, {
    idempotencyKey: 'test:identity-update-second',
    expectedItemId: 'item-second',
  });

  const [current] = await getAll('meals');
  assert.equal(current.items.length, 1);
  assert.equal(current.items[0].itemId, 'item-second');
  assert.equal(current.items[0].quantity, 3);
});

test('undo restores the exact item version removed after a concurrent edit', async () => {
  await clearAllData();
  const originalItem = { ...validMeal.items[0], itemId: 'concurrent-item' };
  const { meal } = await createMeal({ ...validMeal, items: [originalItem] }, {
    idempotencyKey: 'test:concurrent-create',
  });

  await updateMealItem(meal.id, 0, { ...originalItem, quantity: 2 }, {
    idempotencyKey: 'test:concurrent-edit',
    expectedItemId: originalItem.itemId,
  });
  const removal = await removeMealItem(meal.id, 0, {
    idempotencyKey: 'test:concurrent-remove',
    expectedItemId: originalItem.itemId,
  });

  assert.equal(removal.removedItem.quantity, 2);
  await restoreMealItem(meal.id, removal.removedIndex, removal.removedItem, {
    idempotencyKey: 'test:concurrent-restore',
  });

  const restored = await getById('meals', meal.id);
  assert.equal(restored.items[0].itemId, originalItem.itemId);
  assert.equal(restored.items[0].quantity, 2);
});

test('a newly discovered food and its referencing meal commit together', async () => {
  await clearAllData();
  const food = {
    id: 'atomic-food',
    name: 'Atomic food',
    servingSize: { quantity: 1, unit: 'serving' },
    nutrients: {
      energy: { kcal: 100 },
      macros: { protein: { g: 1 }, carbs: { g: 2 }, fat: { g: 3 } },
      fiber: { g: null },
      sodium: { mg: null },
    },
  };
  const input = {
    ...validMeal,
    items: [{ ...validMeal.items[0], foodId: food.id }],
  };
  const first = await createMeal(input, {
    idempotencyKey: 'test:atomic-food-meal',
    relatedFoods: [food],
  });
  assert.equal(first.created, true);
  assert.equal((await getById('foods', food.id)).name, 'Atomic food');
  assert.equal(first.meal.items[0].foodId, food.id);

  const storedFood = await getById('foods', food.id);
  const second = await createMeal(input, {
    idempotencyKey: 'test:atomic-food-meal',
    relatedFoods: [{ ...food, name: 'Must not rewrite on retry' }],
  });
  assert.equal(second.created, false);
  assert.equal((await getById('foods', food.id)).updatedAt, storedFood.updatedAt);
  assert.equal((await getById('foods', food.id)).name, 'Atomic food');
});
