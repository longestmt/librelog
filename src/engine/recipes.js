import { getNutritionMultiplierOrNull } from '../utils/units.js';
import { createDraftItem } from '../data/add-draft.js';

const RECIPE_NUTRIENTS = Object.freeze({
  kcal: food => food.nutrients?.energy?.kcal,
  protein: food => food.nutrients?.macros?.protein?.g,
  carbs: food => food.nutrients?.macros?.carbs?.g,
  fat: food => food.nutrients?.macros?.fat?.g,
  fiber: food => food.nutrients?.fiber?.g,
});

/** Freeze a pre-0.4 recipe ingredient against the catalog values visible now. */
export function ensureRecipeItemSnapshot(item, food) {
  if (!item || item.basisSnapshot || !food) return item;
  const snapshot = createDraftItem(food, {
    quantity: item.quantity,
    unit: item.unit,
    inputMethod: 'recipe ingredient',
    nutritionSource: 'Recipe ingredient',
  });
  return {
    ...item,
    nameSnapshot: item.nameSnapshot || snapshot.nameSnapshot,
    brandSnapshot: item.brandSnapshot || snapshot.brandSnapshot,
    basisSnapshot: snapshot.basisSnapshot,
    provenance: item.provenance || snapshot.provenance,
  };
}

export function scaleRecipeItemQuantity(itemQuantity, recipeServings, portionServings) {
  const quantity = Number(itemQuantity);
  const yieldCount = Number(recipeServings);
  const portions = Number(portionServings);
  if (![quantity, yieldCount, portions].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Recipe quantities and servings must be positive numbers');
  }
  return (quantity / yieldCount) * portions;
}

/** Prefer the immutable ingredient basis saved with a recipe. */
export function getRecipeItemFood(item, foodsMap) {
  const basis = item?.basisSnapshot;
  if (!basis) return foodsMap.get(item.foodId) || null;
  return {
    id: item.foodId,
    name: item.nameSnapshot || foodsMap.get(item.foodId)?.name || 'Recipe ingredient',
    brand: item.brandSnapshot || '',
    servingSize: {
      quantity: basis.quantity,
      unit: basis.unit,
      gramsPerUnit: basis.gramsPerUnit,
      aliases: basis.aliases || [],
      label: basis.label || null,
      packageQuantity: basis.packageQuantity,
      packageUnit: basis.packageUnit,
    },
    nutrients: {
      energy: { kcal: basis.nutrients?.kcal },
      macros: {
        protein: { g: basis.nutrients?.protein },
        carbs: { g: basis.nutrients?.carbs },
        fat: { g: basis.nutrients?.fat },
      },
      fiber: { g: basis.nutrients?.fiber },
      sodium: { mg: basis.nutrients?.sodium },
    },
  };
}

export function calculateRecipeNutrition(items, foodsMap, servings = 1) {
  const totals = Object.fromEntries(Object.keys(RECIPE_NUTRIENTS).map(key => [key, 0]));
  const incomplete = new Set();

  for (const item of items || []) {
    const food = getRecipeItemFood(item, foodsMap);
    if (!food) {
      Object.keys(RECIPE_NUTRIENTS).forEach(key => incomplete.add(key));
      continue;
    }
    const multiplier = getNutritionMultiplierOrNull(item.quantity, item.unit, food);
    if (multiplier == null) {
      Object.keys(RECIPE_NUTRIENTS).forEach(key => incomplete.add(key));
      continue;
    }
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
