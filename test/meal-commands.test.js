import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, getAll } from '../src/data/db.js';
import { createMeal, validateMealInput } from '../src/data/meal-commands.js';

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
