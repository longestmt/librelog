import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRecipeNutrition,
  ensureRecipeItemSnapshot,
  scaleRecipeItemQuantity,
} from '../src/engine/recipes.js';
import { createDraftItem } from '../src/data/add-draft.js';

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

test('recipe nutrition prefers its saved ingredient basis over later catalog edits', () => {
  const snapshot = createDraftItem(completeFood, { quantity: 100, unit: 'g' });
  const recipeItem = {
    foodId: completeFood.id,
    quantity: 100,
    unit: 'g',
    nameSnapshot: snapshot.nameSnapshot,
    basisSnapshot: snapshot.basisSnapshot,
  };
  const changedCatalogFood = {
    ...completeFood,
    nutrients: { ...completeFood.nutrients, energy: { kcal: 999 } },
  };

  const result = calculateRecipeNutrition(
    [recipeItem],
    new Map([[completeFood.id, changedCatalogFood]]),
    1,
  );
  assert.equal(result.kcal, 200);
});

test('a legacy recipe ingredient is snapshotted before later catalog edits', () => {
  const legacyItem = { foodId: completeFood.id, quantity: 100, unit: 'g' };
  const upgradedItem = ensureRecipeItemSnapshot(legacyItem, completeFood);
  const changedCatalogFood = {
    ...completeFood,
    nutrients: { ...completeFood.nutrients, energy: { kcal: 999 } },
  };

  assert.equal(legacyItem.basisSnapshot, undefined);
  assert.equal(upgradedItem.basisSnapshot.nutrients.kcal, 200);
  const result = calculateRecipeNutrition(
    [upgradedItem],
    new Map([[completeFood.id, changedCatalogFood]]),
    1,
  );
  assert.equal(result.kcal, 200);
});

test('a legacy recipe with an unsupported ingredient unit stays readable with unknown nutrition', () => {
  const legacyItem = { foodId: completeFood.id, quantity: 1, unit: 'clove' };
  const upgradedItem = ensureRecipeItemSnapshot(legacyItem, completeFood);
  const result = calculateRecipeNutrition(
    [upgradedItem],
    new Map([[completeFood.id, completeFood]]),
    1,
  );

  assert.equal(upgradedItem.unit, 'clove');
  assert.equal(result.kcal, 0);
  assert.deepEqual(result.incomplete.sort(), ['carbs', 'fat', 'fiber', 'kcal', 'protein']);
});

test('tiny positive recipe portions never round into a full serving fallback', () => {
  const quantity = scaleRecipeItemQuantity(0.1, 100, 0.25);
  const draftItem = createDraftItem(completeFood, { quantity, unit: 'g' });

  assert.equal(quantity, 0.00025);
  assert.equal(draftItem.quantity, 0.00025);
  assert.notEqual(draftItem.quantity, completeFood.servingSize.quantity);
});
