import { getNutritionMultiplier } from '../utils/units.js';

const RECIPE_NUTRIENTS = Object.freeze({
  kcal: food => food.nutrients?.energy?.kcal,
  protein: food => food.nutrients?.macros?.protein?.g,
  carbs: food => food.nutrients?.macros?.carbs?.g,
  fat: food => food.nutrients?.macros?.fat?.g,
  fiber: food => food.nutrients?.fiber?.g,
});

export function calculateRecipeNutrition(items, foodsMap, servings = 1) {
  const totals = Object.fromEntries(Object.keys(RECIPE_NUTRIENTS).map(key => [key, 0]));
  const incomplete = new Set();

  for (const item of items || []) {
    const food = foodsMap.get(item.foodId);
    if (!food) {
      Object.keys(RECIPE_NUTRIENTS).forEach(key => incomplete.add(key));
      continue;
    }
    const multiplier = getNutritionMultiplier(item.quantity, item.unit, food);
    for (const [key, readValue] of Object.entries(RECIPE_NUTRIENTS)) {
      const value = readValue(food);
      if (value == null || !Number.isFinite(Number(value))) {
        incomplete.add(key);
      } else {
        totals[key] += Number(value) * multiplier;
      }
    }
  }

  const divisor = Number.isFinite(Number(servings)) && Number(servings) > 0
    ? Number(servings)
    : 1;
  return {
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / divisor])),
    incomplete: [...incomplete],
  };
}
