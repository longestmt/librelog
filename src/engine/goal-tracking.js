/**
 * Goal tracking engine
 * Manages nutrition goals and calculates progress toward targets
 */

import { getSetting, setSetting } from '../data/db.js';

const GOALS_KEY = 'nutritionGoals';

/**
 * Default nutrition goals
 * @private
 */
const DEFAULT_GOALS = {
  calorieTarget: 2000,
  proteinG: 150,
  carbG: 225,
  fatG: 65,
  fiberG: 30,
  sodiumMg: 2300
};

/**
 * Retrieve user's nutrition goals from settings
 * Returns defaults if not yet configured
 * @returns {Promise<Object>} Goals object with all nutrition targets
 */
async function getGoals() {
  try {
    const stored = await getSetting(GOALS_KEY);

    if (!stored) {
      return { ...DEFAULT_GOALS };
    }

    // Merge stored goals with defaults to handle new goal types
    return {
      calorieTarget: stored.calorieTarget ?? DEFAULT_GOALS.calorieTarget,
      proteinG: stored.proteinG ?? DEFAULT_GOALS.proteinG,
      carbG: stored.carbG ?? DEFAULT_GOALS.carbG,
      fatG: stored.fatG ?? DEFAULT_GOALS.fatG,
      fiberG: stored.fiberG ?? DEFAULT_GOALS.fiberG,
      sodiumMg: stored.sodiumMg ?? DEFAULT_GOALS.sodiumMg
    };
  } catch (error) {
    console.error('Error retrieving goals:', error);
    return { ...DEFAULT_GOALS };
  }
}

/**
 * Save user's nutrition goals to settings
 * @param {Object} goals - Goals object to save
 * @param {number} [goals.calorieTarget] - Daily calorie target
 * @param {number} [goals.proteinG] - Daily protein target in grams
 * @param {number} [goals.carbG] - Daily carbohydrate target in grams
 * @param {number} [goals.fatG] - Daily fat target in grams
 * @param {number} [goals.fiberG] - Daily fiber target in grams
 * @param {number} [goals.sodiumMg] - Daily sodium target in milligrams
 * @returns {Promise<void>}
 */
async function setGoals(goals) {
  if (!goals || typeof goals !== 'object') {
    console.error('Invalid goals object');
    return;
  }

  try {
    // Validate numeric values
    const validatedGoals = {
      calorieTarget: Number(goals.calorieTarget) || DEFAULT_GOALS.calorieTarget,
      proteinG: Number(goals.proteinG) || DEFAULT_GOALS.proteinG,
      carbG: Number(goals.carbG) || DEFAULT_GOALS.carbG,
      fatG: Number(goals.fatG) || DEFAULT_GOALS.fatG,
      fiberG: Number(goals.fiberG) || DEFAULT_GOALS.fiberG,
      sodiumMg: Number(goals.sodiumMg) || DEFAULT_GOALS.sodiumMg
    };

    // Ensure all values are positive
    for (const key in validatedGoals) {
      if (validatedGoals[key] < 0) {
        validatedGoals[key] = DEFAULT_GOALS[key];
      }
    }

    await setSetting(GOALS_KEY, validatedGoals);
  } catch (error) {
    console.error('Error saving goals:', error);
  }
}

/**
 * Calculate progress toward goals for all nutrients
 * Returns percentage achieved and status for each nutrient
 * @param {Object} dayTotals - Daily totals { kcal, protein, carbs, fat, fiber, sodium }
 * @param {Object} goals - Goals object from getGoals()
 * @returns {Object} Progress object with percentage and status for each nutrient
 */
function getProgress(dayTotals, goals) {
  if (!dayTotals || !goals) {
    return {
      calories: { percentage: 0, status: 'under' },
      protein: { percentage: 0, status: 'under' },
      carbs: { percentage: 0, status: 'under' },
      fat: { percentage: 0, status: 'under' },
      fiber: { percentage: 0, status: 'under' },
      sodium: { percentage: 0, status: 'under' }
    };
  }

  try {
    const progress = {};

    // Calories
    const caloriePercent = Math.round(
      (dayTotals.kcal / goals.calorieTarget) * 100
    );
    progress.calories = {
      percentage: Math.max(0, caloriePercent),
      status: determineStatus(caloriePercent)
    };

    // Protein
    const proteinPercent = Math.round(
      (dayTotals.protein / goals.proteinG) * 100
    );
    progress.protein = {
      percentage: Math.max(0, proteinPercent),
      status: determineStatus(proteinPercent)
    };

    // Carbs
    const carbsPercent = Math.round(
      (dayTotals.carbs / goals.carbG) * 100
    );
    progress.carbs = {
      percentage: Math.max(0, carbsPercent),
      status: determineStatus(carbsPercent)
    };

    // Fat
    const fatPercent = Math.round(
      (dayTotals.fat / goals.fatG) * 100
    );
    progress.fat = {
      percentage: Math.max(0, fatPercent),
      status: determineStatus(fatPercent)
    };

    // Fiber
    const fiberPercent = Math.round(
      (dayTotals.fiber / goals.fiberG) * 100
    );
    progress.fiber = {
      percentage: Math.max(0, fiberPercent),
      status: determineStatus(fiberPercent)
    };

    // Sodium
    const sodiumPercent = Math.round(
      (dayTotals.sodium / goals.sodiumMg) * 100
    );
    progress.sodium = {
      percentage: Math.max(0, sodiumPercent),
      status: determineStatus(sodiumPercent)
    };

    return progress;
  } catch (error) {
    console.error('Error calculating progress:', error);
    return {
      calories: { percentage: 0, status: 'under' },
      protein: { percentage: 0, status: 'under' },
      carbs: { percentage: 0, status: 'under' },
      fat: { percentage: 0, status: 'under' },
      fiber: { percentage: 0, status: 'under' },
      sodium: { percentage: 0, status: 'under' }
    };
  }
}

/**
 * Determine status based on percentage achieved
 * Status ranges:
 * - 'under': < 90%
 * - 'on-track': 90-110%
 * - 'over': > 110%
 * @private
 * @param {number} percentage - Percentage achieved (0-infinity)
 * @returns {string} Status: 'under', 'on-track', or 'over'
 */
function determineStatus(percentage) {
  if (percentage < 90) {
    return 'under';
  }
  if (percentage > 110) {
    return 'over';
  }
  return 'on-track';
}

export {
  getGoals,
  setGoals,
  getProgress
};
