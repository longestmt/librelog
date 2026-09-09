import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, formatDate, toLocalDate } from '../src/utils/format.js';
import { getNutritionMultiplier, getUnitsForFood } from '../src/utils/units.js';
import { scaleNutrients, calculateDayTotalsSimple } from '../src/engine/nutrition.js';
import { normalizeProduct } from '../src/integrations/openfoodfacts.js';
import { normalizeFood } from '../src/integrations/usdaFdc.js';
import { DEFAULT_FOODS } from '../src/data/seed-foods.js';
import { getProgress } from '../src/engine/goal-tracking.js';

const egg = {
  servingSize: { quantity: 1, unit: 'large' },
  nutrients: {
    energy: { kcal: 70 },
    macros: { protein: { g: 6 }, carbs: { g: 0.5 }, fat: { g: 5 } },
    fiber: { g: null },
    sodium: { mg: 70 },
  },
};

test('parses bare calendar dates in local time', () => {
  const date = toLocalDate('2026-07-27');
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 6);
  assert.equal(date.getDate(), 27);
  assert.match(formatDate('2026-07-27'), /Jul 27/);
});

test('adds calendar days across month and DST boundaries', () => {
  assert.equal(addCalendarDays('2026-03-07', 2), '2026-03-09');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addCalendarDays('2026-03-01', -1), '2026-02-28');
});

test('one count-based serving has a multiplier of one', () => {
  assert.equal(getNutritionMultiplier(1, 'large', egg), 1);
  assert.equal(scaleNutrients(egg, 1, 'large').kcal, 70);
});

test('count-based foods hide mass units without an explicit conversion', () => {
  assert.deepEqual(getUnitsForFood(egg), [{ value: 'large', label: 'large' }]);
  assert.throws(
    () => getNutritionMultiplier(50, 'g', egg),
    /No gram conversion is defined/
  );
});

test('count-based foods allow mass units with an explicit conversion', () => {
  const eggWithWeight = {
    ...egg,
    servingSize: { ...egg.servingSize, gramsPerUnit: 50 },
  };

  assert.deepEqual(
    getUnitsForFood(eggWithWeight).map(unit => unit.value),
    ['large', 'g', 'oz']
  );
  assert.equal(getNutritionMultiplier(50, 'g', eggWithWeight), 1);
});

test('seeded count foods carry the weight conversion behind their nutrition', () => {
  const seededEgg = DEFAULT_FOODS.find(food => food.name === 'Egg, large');
  assert.equal(getNutritionMultiplier(50, 'g', seededEgg), 1);
  assert.equal(scaleNutrients(seededEgg, 50, 'g').kcal, 70);
});

test('unit conversion scales mass servings', () => {
  const food = { ...egg, servingSize: { quantity: 100, unit: 'g' } };
  assert.ok(Math.abs(getNutritionMultiplier(1, 'oz', food) - 0.283495) < 0.000001);
});

test('missing nutrients remain unknown while totals stay usable', () => {
  const scaled = scaleNutrients(egg, 1, 'large');
  assert.equal(scaled.fiber, null);
  const totals = calculateDayTotalsSimple([{ items: [{ nutrients: scaled }] }]);
  assert.equal(totals.kcal, 70);
  assert.deepEqual(totals.incomplete, ['fiber']);
});

test('an absent meal-item nutrition snapshot marks every nutrient incomplete', () => {
  const totals = calculateDayTotalsSimple([{ items: [{ foodId: 'legacy-food' }] }]);
  assert.deepEqual(totals.incomplete, ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sodium']);
});

test('Open Food Facts sodium grams are converted to milligrams', () => {
  const food = normalizeProduct({
    code: '123',
    product_name: 'Fixture',
    nutriments: {
      'energy-kcal_100g': 100,
      proteins_100g: 2,
      carbohydrates_100g: 10,
      fat_100g: 4,
      sodium_100g: 0.42,
    },
  });
  assert.equal(food.nutrients.sodium.mg, 420);
  assert.equal(food.nutrients.fiber.g, null);
});

test('USDA normalization distinguishes missing values from zero', () => {
  const food = normalizeFood({
    fdcId: 1,
    description: 'Fixture',
    foodNutrients: [
      { nutrientId: 1008, value: 0 },
      { nutrientId: 1003, value: 3 },
    ],
  });
  assert.equal(food.nutrients.energy.kcal, 0);
  assert.equal(food.nutrients.macros.protein.g, 3);
  assert.equal(food.nutrients.macros.carbs.g, null);
});

test('zero nutrient goals are disabled without NaN or Infinity progress', () => {
  const progress = getProgress(
    { kcal: 500, protein: 20, carbs: 30, fat: 10, fiber: 5, sodium: 600 },
    { calorieTarget: 2000, proteinG: 0, carbG: 0, fatG: 0, fiberG: 0, sodiumMg: 0 },
  );

  assert.deepEqual(progress.calories, { percentage: 25, status: 'under' });
  for (const nutrient of ['protein', 'carbs', 'fat', 'fiber', 'sodium']) {
    assert.deepEqual(progress[nutrient], { percentage: 0, status: 'disabled' });
    assert.equal(Number.isFinite(progress[nutrient].percentage), true);
  }
});
