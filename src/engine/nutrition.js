/**
 * Nutrition calculation engine
 * Handles meal totals, daily totals, and nutrient scaling
 */

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
    return {
      kcal: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      fiber: 0,
      sodium: 0
    };
  }

  try {
    // Calculate scale factor relative to serving size
    // Currently assumes unit matches food's serving size unit (grams)
    const scale = quantity / food.servingSize.quantity;

    return {
      kcal: Math.round((food.nutrients.energy?.kcal || 0) * scale * 10) / 10,
      protein: Math.round((food.nutrients.macros?.protein?.g || 0) * scale * 100) / 100,
      carbs: Math.round((food.nutrients.macros?.carbs?.g || 0) * scale * 100) / 100,
      fat: Math.round((food.nutrients.macros?.fat?.g || 0) * scale * 100) / 100,
      fiber: Math.round((food.nutrients.fiber?.g || 0) * scale * 100) / 100,
      sodium: Math.round((food.nutrients.sodium?.mg || 0) * scale * 10) / 10
    };
  } catch (error) {
    console.error('Error scaling nutrients:', error);
    return {
      kcal: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      fiber: 0,
      sodium: 0
    };
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
  const totals = {
    kcal: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
    sodium: 0
  };

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

      totals.kcal += scaled.kcal;
      totals.protein += scaled.protein;
      totals.carbs += scaled.carbs;
      totals.fat += scaled.fat;
      totals.fiber += scaled.fiber;
      totals.sodium += scaled.sodium;
    }

    // Round final totals
    return {
      kcal: Math.round(totals.kcal * 10) / 10,
      protein: Math.round(totals.protein * 100) / 100,
      carbs: Math.round(totals.carbs * 100) / 100,
      fat: Math.round(totals.fat * 100) / 100,
      fiber: Math.round(totals.fiber * 100) / 100,
      sodium: Math.round(totals.sodium * 10) / 10
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
  const dayTotals = {
    kcal: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
    sodium: 0
  };

  if (!meals || meals.length === 0 || !foodsMap) {
    return dayTotals;
  }

  try {
    for (const meal of meals) {
      if (!meal.items || meal.items.length === 0) {
        continue;
      }

      const mealTotals = calculateMealTotals(meal.items, foodsMap);

      dayTotals.kcal += mealTotals.kcal;
      dayTotals.protein += mealTotals.protein;
      dayTotals.carbs += mealTotals.carbs;
      dayTotals.fat += mealTotals.fat;
      dayTotals.fiber += mealTotals.fiber;
      dayTotals.sodium += mealTotals.sodium;
    }

    // Round final totals
    return {
      kcal: Math.round(dayTotals.kcal * 10) / 10,
      protein: Math.round(dayTotals.protein * 100) / 100,
      carbs: Math.round(dayTotals.carbs * 100) / 100,
      fat: Math.round(dayTotals.fat * 100) / 100,
      fiber: Math.round(dayTotals.fiber * 100) / 100,
      sodium: Math.round(dayTotals.sodium * 10) / 10
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
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };
  if (!meals || meals.length === 0) return totals;
  for (const meal of meals) {
    for (const item of (meal.items || [])) {
      if (item.nutrients) {
        totals.kcal += item.nutrients.kcal || 0;
        totals.protein += item.nutrients.protein || 0;
        totals.carbs += item.nutrients.carbs || 0;
        totals.fat += item.nutrients.fat || 0;
        totals.fiber += item.nutrients.fiber || 0;
        totals.sodium += item.nutrients.sodium || 0;
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
