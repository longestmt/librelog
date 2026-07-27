import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRecipeNutrition } from '../src/engine/recipes.js';

const completeFood = {
  id: 'complete',
  servingSize: { quantity: 100, unit: 'g' },
  nutrients: {
    energy: { kcal: 200 },
    macros: {
      protein: { g: 10 },
      carbs: { g: 20 },
      fat: { g: 8 },
    },
    fiber: { g: 4 },
  },
};

test('recipe nutrition scales known values per serving', () => {
  const foods = new Map([[completeFood.id, completeFood]]);
  const result = calculateRecipeNutrition(
    [{ foodId: completeFood.id, quantity: 200, unit: 'g' }],
    foods,
    2,
  );
  assert.equal(result.kcal, 200);
  assert.equal(result.protein, 10);
  assert.deepEqual(result.incomplete, []);
});

test('recipe nutrition identifies unknown values instead of reporting zero', () => {
  const partialFood = {
    ...completeFood,
    id: 'partial',
    nutrients: { ...completeFood.nutrients, fiber: { g: null } },
  };
  const foods = new Map([[partialFood.id, partialFood]]);
  const result = calculateRecipeNutrition(
    [{ foodId: partialFood.id, quantity: 100, unit: 'g' }],
    foods,
    1,
  );
  assert.equal(result.fiber, 0);
  assert.deepEqual(result.incomplete, ['fiber']);
});
