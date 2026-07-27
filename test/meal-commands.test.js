import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, getAll } from '../src/data/db.js';
import {
  copyMealsToDate,
  createMeal,
  removeMealItem,
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
  const changedItem = { ...validMeal.items[0], quantity: 2 };

  const firstEdit = await updateMealItem(meal.id, 0, changedItem, {
    idempotencyKey: 'test:meal-mutation-edit',
  });
  const repeatedEdit = await updateMealItem(meal.id, 0, changedItem, {
    idempotencyKey: 'test:meal-mutation-edit',
  });
  assert.equal(firstEdit.changed, true);
  assert.equal(repeatedEdit.changed, false);
  assert.equal(repeatedEdit.meal.items[0].quantity, 2);

  const firstRemove = await removeMealItem(meal.id, 0, {
    idempotencyKey: 'test:meal-mutation-remove',
  });
  const repeatedRemove = await removeMealItem(meal.id, 0, {
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
