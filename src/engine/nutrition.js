/**
 * Nutrition calculation engine
 * Handles meal totals, daily totals, and nutrient scaling
 */

import { getNutritionMultiplier } from '../utils/units.js';

const NUTRIENT_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sodium'];

function emptyTotals() {
  return {
    kcal: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
    sodium: 0,
    incomplete: []
  };
}

function scaledValue(value, scale, precision) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  return Math.round(value * scale * factor) / factor;
}

/**
 * Scale nutrient values based on quantity relative to serving size
 * Assumes same unit as food's serving size (grams)
 * @param {Object} food - Food object with nutrients and servingSize
 * @param {number} quantity - Quantity consumed
 * @param {string} unit - Unit of measurement (currently assumes grams)
 * @returns {Object} Scaled nutrient object
 */
function scaleNutrients(food, quantity, unit = 'g') {
  if (!food || !food.nutrients || !food.servingSize) {
    return Object.fromEntries(NUTRIENT_KEYS.map(key => [key, null]));
  }

  try {
    const scale = getNutritionMultiplier(quantity, unit, food);

    return {
      kcal: scaledValue(food.nutrients.energy?.kcal, scale, 1),
      protein: scaledValue(food.nutrients.macros?.protein?.g, scale, 2),
      carbs: scaledValue(food.nutrients.macros?.carbs?.g, scale, 2),
      fat: scaledValue(food.nutrients.macros?.fat?.g, scale, 2),
      fiber: scaledValue(food.nutrients.fiber?.g, scale, 2),
      sodium: scaledValue(food.nutrients.sodium?.mg, scale, 1)
    };
  } catch (error) {
    console.error('Error scaling nutrients:', error);
    return Object.fromEntries(NUTRIENT_KEYS.map(key => [key, null]));
  }
}

/**
 * Calculate totals for a single meal
 * @private
 * @param {Array} items - Array of meal items with foodId, quantity, unit
 * @param {Map} foodsMap - Map of food records keyed by foodId
 * @returns {Object} Aggregated totals
 */
function calculateMealTotals(items, foodsMap) {
  const totals = emptyTotals();

  if (!items || items.length === 0 || !foodsMap) {
    return totals;
  }

  try {
    for (const item of items) {
      const food = foodsMap.get(item.foodId);

      if (!food) {
        console.warn(`Food not found in map: ${item.foodId}`);
        continue;
      }

      const scaled = scaleNutrients(
        food,
        item.quantity || 0,
        item.unit || 'g'
      );

      for (const key of NUTRIENT_KEYS) {
        if (Number.isFinite(scaled[key])) totals[key] += scaled[key];
        else if (!totals.incomplete.includes(key)) totals.incomplete.push(key);
      }
    }

    // Round final totals
    return {
      kcal: Math.round(totals.kcal * 10) / 10,
      protein: Math.round(totals.protein * 100) / 100,
      carbs: Math.round(totals.carbs * 100) / 100,
      fat: Math.round(totals.fat * 100) / 100,
      fiber: Math.round(totals.fiber * 100) / 100,
      sodium: Math.round(totals.sodium * 10) / 10,
      incomplete: totals.incomplete
    };
  } catch (error) {
    console.error('Error calculating meal totals:', error);
    return totals;
  }
}

/**
 * Calculate daily totals by summing across all meals
 * @param {Array} meals - Array of meal objects with items
 * @param {Map} foodsMap - Map of food records keyed by foodId
 * @returns {Object} Daily aggregate totals
 */
function calculateDayTotals(meals, foodsMap) {
  const dayTotals = emptyTotals();

  if (!meals || meals.length === 0 || !foodsMap) {
    return dayTotals;
  }

  try {
    for (const meal of meals) {
      if (!meal.items || meal.items.length === 0) {
        continue;
      }

      const mealTotals = calculateMealTotals(meal.items, foodsMap);

      for (const key of NUTRIENT_KEYS) dayTotals[key] += mealTotals[key];
      for (const key of mealTotals.incomplete || []) {
        if (!dayTotals.incomplete.includes(key)) dayTotals.incomplete.push(key);
      }
    }

    // Round final totals
    return {
      kcal: Math.round(dayTotals.kcal * 10) / 10,
      protein: Math.round(dayTotals.protein * 100) / 100,
      carbs: Math.round(dayTotals.carbs * 100) / 100,
      fat: Math.round(dayTotals.fat * 100) / 100,
      fiber: Math.round(dayTotals.fiber * 100) / 100,
      sodium: Math.round(dayTotals.sodium * 10) / 10,
      incomplete: dayTotals.incomplete
    };
  } catch (error) {
    console.error('Error calculating day totals:', error);
    return dayTotals;
  }
}

/**
 * Calculate remaining calories for the day
 * @param {Object} dayTotals - Daily totals object
 * @param {number} calorieTarget - Target calorie goal
 * @returns {number} Remaining calories (can be negative)
 */
function getRemainingCalories(dayTotals, calorieTarget) {
  if (!dayTotals || !dayTotals.kcal) {
    return calorieTarget;
  }

  try {
    return Math.round((calorieTarget - dayTotals.kcal) * 10) / 10;
  } catch (error) {
    console.error('Error calculating remaining calories:', error);
    return calorieTarget;
  }
}

/**
 * Calculate macronutrient percentages based on total calories
 * @param {Object} dayTotals - Daily totals object
 * @returns {Object} Macro percentages { protein: %, carbs: %, fat: % }
 */
function getMacroPercentages(dayTotals) {
  const percentages = {
    protein: 0,
    carbs: 0,
    fat: 0
  };

  if (!dayTotals || !dayTotals.kcal || dayTotals.kcal === 0) {
    return percentages;
  }

  try {
    const totalCalories = dayTotals.kcal;

    // 1g protein = 4 kcal, 1g carbs = 4 kcal, 1g fat = 9 kcal
    const proteinCals = (dayTotals.protein || 0) * 4;
    const carbsCals = (dayTotals.carbs || 0) * 4;
    const fatCals = (dayTotals.fat || 0) * 9;

    percentages.protein = Math.round((proteinCals / totalCalories) * 100 * 10) / 10;
    percentages.carbs = Math.round((carbsCals / totalCalories) * 100 * 10) / 10;
    percentages.fat = Math.round((fatCals / totalCalories) * 100 * 10) / 10;

    return percentages;
  } catch (error) {
    console.error('Error calculating macro percentages:', error);
    return percentages;
  }
}

/**
 * Calculate daily totals from meals with embedded nutrition on items
 * Use this when items already have computed nutrients stored at log time
 * @param {Array} meals - Array of meal objects with items
 * @returns {Object} Daily aggregate totals
 */
function calculateDayTotalsSimple(meals) {
  const totals = emptyTotals();
  if (!meals || meals.length === 0) return totals;
  for (const meal of meals) {
    for (const item of (meal.items || [])) {
      if (item.nutrients) {
        for (const key of NUTRIENT_KEYS) {
          if (Number.isFinite(item.nutrients[key])) totals[key] += item.nutrients[key];
          else if (!totals.incomplete.includes(key)) totals.incomplete.push(key);
        }
      }
    }
  }
  totals.kcal = Math.round(totals.kcal);
  totals.protein = Math.round(totals.protein * 10) / 10;
  totals.carbs = Math.round(totals.carbs * 10) / 10;
  totals.fat = Math.round(totals.fat * 10) / 10;
  totals.fiber = Math.round(totals.fiber * 10) / 10;
  totals.sodium = Math.round(totals.sodium);
  return totals;
}

export {
  scaleNutrients,
  calculateMealTotals,
  calculateDayTotals,
  calculateDayTotalsSimple,
  getRemainingCalories,
  getMacroPercentages
};
