import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOODS } from '../src/data/seed-foods.js';
import {
  backfillItemIds,
  canonicalSeedFoodId,
} from '../src/data/identity.js';

test('independent installations derive the same unique built-in food IDs', () => {
  const firstInstall = DEFAULT_FOODS.map(food => structuredClone(food));
  const secondInstall = DEFAULT_FOODS.map(food => structuredClone(food));
  assert.deepEqual(firstInstall.map(food => food.id), secondInstall.map(food => food.id));
  assert.equal(new Set(firstInstall.map(food => food.id)).size, firstInstall.length);
  assert.equal(firstInstall.every(food => food.id === canonicalSeedFoodId(food)), true);
});
test('legacy child IDs backfill deterministically and retain distinct positions', () => {
  const items = [
    { foodId: 'food-1', quantity: 1, unit: 'serving' },
    { foodId: 'food-1', quantity: 1, unit: 'serving' },
  ];
  const first = backfillItemIds('meal-1', items);
  const second = backfillItemIds('meal-1', structuredClone(items));
  assert.deepEqual(first, second);
  assert.notEqual(first[0].itemId, first[1].itemId);
  assert.equal(backfillItemIds('meal-1', first)[0].itemId, first[0].itemId);
});
