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

const GOAL_RANGES = {
  calorieTarget: [500, 10_000],
  proteinG: [0, 1_000],
  carbG: [0, 2_000],
  fatG: [0, 1_000],
  fiberG: [0, 500],
  sodiumMg: [0, 50_000],
};

function validGoal(value, key) {
  const number = Number(value);
  const [minimum, maximum] = GOAL_RANGES[key];
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : DEFAULT_GOALS[key];
}

function calculateGoalProgress(value, target) {
  const numericTarget = Number(target);
  if (!Number.isFinite(numericTarget) || numericTarget <= 0) {
    return { percentage: 0, status: 'disabled' };
  }

  const numericValue = Number(value);
  const percentage = Number.isFinite(numericValue)
    ? Math.max(0, Math.round((numericValue / numericTarget) * 100))
    : 0;
  return { percentage, status: determineStatus(percentage) };
}

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
      calorieTarget: validGoal(stored.calorieTarget, 'calorieTarget'),
      proteinG: validGoal(stored.proteinG, 'proteinG'),
      carbG: validGoal(stored.carbG, 'carbG'),
      fatG: validGoal(stored.fatG, 'fatG'),
      fiberG: validGoal(stored.fiberG, 'fiberG'),
      sodiumMg: validGoal(stored.sodiumMg, 'sodiumMg')
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
async function setGoals(goals, options = {}) {
  if (!goals || typeof goals !== 'object') {
    console.error('Invalid goals object');
    return;
  }

  try {
    // Validate numeric values
    const validatedGoals = {
      calorieTarget: validGoal(goals.calorieTarget, 'calorieTarget'),
      proteinG: validGoal(goals.proteinG, 'proteinG'),
      carbG: validGoal(goals.carbG, 'carbG'),
      fatG: validGoal(goals.fatG, 'fatG'),
      fiberG: validGoal(goals.fiberG, 'fiberG'),
      sodiumMg: validGoal(goals.sodiumMg, 'sodiumMg')
    };

    await setSetting(GOALS_KEY, validatedGoals, options);
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
    return {
      calories: calculateGoalProgress(dayTotals.kcal, goals.calorieTarget),
      protein: calculateGoalProgress(dayTotals.protein, goals.proteinG),
      carbs: calculateGoalProgress(dayTotals.carbs, goals.carbG),
      fat: calculateGoalProgress(dayTotals.fat, goals.fatG),
      fiber: calculateGoalProgress(dayTotals.fiber, goals.fiberG),
      sodium: calculateGoalProgress(dayTotals.sodium, goals.sodiumMg),
    };
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
 * @returns {string} Status: 'under', 'on-track', or 'over'. A disabled target
 * is handled before this helper is called.
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
