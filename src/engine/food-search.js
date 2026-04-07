/**
 * Unified food search engine
 * Combines local database searches with Open Food Facts API results
 */

import { getAll, getByIndex, getSetting } from '../data/db.js';
import * as openfoodfacts from '../integrations/openfoodfacts.js';
import { getCached, setCache } from '../integrations/cache.js';

let usdaModule = null;
async function getUsda() {
  if (usdaModule) return usdaModule;
  try {
    usdaModule = await import('../integrations/usdaFdc.js');
    return usdaModule;
  } catch { return null; }
}

const LOCAL_STORE_NAME = 'foods';
const MEALS_STORE_NAME = 'meals';

/**
 * Calculate similarity between two strings for deduplication
 * Returns true if strings are very similar (simple heuristic)
 * @private
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {boolean} Whether strings are similar
 */
function areSimilarNames(str1, str2) {
  if (!str1 || !str2) return false;

  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  // Exact match
  if (s1 === s2) return true;

  // Remove common brand/product qualifiers for comparison
  const normalize = str => str
    .replace(/\b(organic|raw|natural|premium|classic|light|zero|diet)\b/gi, '')
    .trim();

  const n1 = normalize(s1);
  const n2 = normalize(s2);

  // Check if normalized versions are very close
  if (n1 === n2) return true;

  // Simple substring check for high similarity
  if (n1.length > 10 && n2.length > 10) {
    const shorter = n1.length < n2.length ? n1 : n2;
    const longer = n1.length < n2.length ? n2 : n1;
    return longer.includes(shorter);
  }

  return false;
}

/**
 * Calculate relevance score for sorting search results
 * Higher score = better match
 * @private
 * @param {string} food - Food name
 * @param {string} query - Search query
 * @returns {number} Relevance score
 */
function calculateRelevance(food, query) {
  if (!food || !query) return 0;

  const foodLower = food.toLowerCase();
  const queryLower = query.toLowerCase();

  // Exact match: highest score
  if (foodLower === queryLower) return 1000;

  // Starts with query: high score
  if (foodLower.startsWith(queryLower)) return 500;

  // Word boundary match: medium score
  const wordBoundaryRegex = new RegExp(`\\b${query}`, 'i');
  if (wordBoundaryRegex.test(food)) return 300;

  // Contains query: lower score
  if (foodLower.includes(queryLower)) return 100;

  return 0;
}

/**
 * Search foods locally and via API
 * Returns combined, deduplicated, and sorted results
 * @param {string} query - Search query
 * @param {Object} [options] - Search options
 * @param {boolean} [options.localOnly=false] - Only search local database
 * @param {number} [options.limit=50] - Maximum results to return
 * @param {number} [options.apiPageSize=20] - Page size for API search
 * @returns {Promise<Array>} Combined results sorted by relevance
 */
async function searchFoods(query, options = {}) {
  const {
    localOnly = false,
    limit = 50,
    apiPageSize = 20
  } = options;

  if (!query || query.trim().length === 0) {
    return [];
  }

  const queryTrim = query.trim();
  const results = [];
  const seenNames = new Set();
  const seenBarcodes = new Set();

  try {
    // Search local database first
    const localFoods = await getAll(LOCAL_STORE_NAME);

    if (localFoods && localFoods.length > 0) {
      const queryLower = queryTrim.toLowerCase();

      for (const food of localFoods) {
        if (!food.isDeleted && food.name) {
          if (food.name.toLowerCase().includes(queryLower)) {
            // Add relevance score for sorting
            food._relevance = calculateRelevance(food.name, queryTrim);
            results.push(food);

            seenNames.add(food.name.toLowerCase());
            if (food.barcode?.ean13) {
              seenBarcodes.add(food.barcode.ean13);
            }
          }
        }
      }
    }

    // If localOnly, stop here
    if (localOnly) {
      return results
        .sort((a, b) => (b._relevance || 0) - (a._relevance || 0))
        .slice(0, limit)
        .map(food => {
          delete food._relevance;
          return food;
        });
    }

    // Search Open Food Facts API
    const cacheKey = `search_${queryTrim}`;
    let apiResults = await getCached('openfoodfacts', cacheKey);

    if (!apiResults) {
      apiResults = await openfoodfacts.searchFoods(
        queryTrim,
        1,
        apiPageSize
      );

      if (apiResults && apiResults.length > 0) {
        // Cache for 24 hours
        await setCache('openfoodfacts', cacheKey, apiResults, 86400);
      }
    }

    // Add API results that aren't duplicates
    // Ensure all API results have IDs (handles stale cache without id field)
    if (apiResults && apiResults.length > 0) {
      for (const apiFood of apiResults) {
        if (!apiFood.id) {
          apiFood.id = `off-${apiFood.barcode?.ean13 || Math.random().toString(36).slice(2, 11)}`;
        }
        const nameLower = apiFood.name?.toLowerCase();
        const barcode = apiFood.barcode?.ean13;

        // Skip if we already have this by name or barcode
        if (seenNames.has(nameLower) || (barcode && seenBarcodes.has(barcode))) {
          continue;
        }

        // Skip if too similar to existing local food
        const isDuplicate = results.some(existing =>
          areSimilarNames(existing.name, apiFood.name)
        );

        if (isDuplicate) {
          continue;
        }

        apiFood._relevance = calculateRelevance(apiFood.name, queryTrim);
        results.push(apiFood);

        if (nameLower) {
          seenNames.add(nameLower);
        }
        if (barcode) {
          seenBarcodes.add(barcode);
        }
      }
    }

    // Search USDA FoodData Central (if API key configured)
    try {
      const usda = await getUsda();
      if (usda) {
        const usdaCacheKey = `usda_search_${queryTrim}`;
        let usdaResults = await getCached('usda', usdaCacheKey);

        if (!usdaResults) {
          usdaResults = await usda.searchFoods(queryTrim, 1, 10);
          if (usdaResults && usdaResults.length > 0) {
            await setCache('usda', usdaCacheKey, usdaResults, 30 * 86400); // 30 days
          }
        }

        if (usdaResults && usdaResults.length > 0) {
          for (const usdaFood of usdaResults) {
            if (!usdaFood.id) continue;
            const nameLower = usdaFood.name?.toLowerCase();
            const isDuplicate = seenNames.has(nameLower) ||
              results.some(existing => areSimilarNames(existing.name, usdaFood.name));
            if (isDuplicate) continue;

            usdaFood._relevance = calculateRelevance(usdaFood.name, queryTrim);
            results.push(usdaFood);
            if (nameLower) seenNames.add(nameLower);
          }
        }
      }
    } catch (err) {
      // USDA search is optional — don't block on failure
      console.warn('USDA search failed:', err);
    }

    // Sort by relevance and return limited results
    return results
      .sort((a, b) => (b._relevance || 0) - (a._relevance || 0))
      .slice(0, limit)
      .map(food => {
        delete food._relevance;
        return food;
      });
  } catch (error) {
    console.error('Error searching foods:', error);
    return results.slice(0, limit);
  }
}

/**
 * Get recently logged foods
 * @param {number} [limit=10] - Maximum foods to return
 * @returns {Promise<Array>} Recently logged foods, most recent first
 */
async function getRecentFoods(limit = 10) {
  try {
    const meals = await getAll(MEALS_STORE_NAME);

    if (!meals || meals.length === 0) {
      return [];
    }

    // Build map of foodId -> most recent timestamp
    const foodIdRecency = new Map();

    for (const meal of meals) {
      if (meal.isDeleted || !meal.items || meal.items.length === 0) {
        continue;
      }

      const mealTime = meal.createdAt || 0;

      for (const item of meal.items) {
        if (item.foodId) {
          if (!foodIdRecency.has(item.foodId) || mealTime > foodIdRecency.get(item.foodId)) {
            foodIdRecency.set(item.foodId, mealTime);
          }
        }
      }
    }

    // Fetch food objects for each unique foodId
    const foods = await getAll(LOCAL_STORE_NAME);
    const foodsMap = new Map();

    if (foods) {
      for (const food of foods) {
        if (!food.isDeleted && food.id) {
          foodsMap.set(food.id, food);
        }
      }
    }

    // Build results with recency timestamps
    const results = [];

    for (const [foodId, timestamp] of foodIdRecency.entries()) {
      const food = foodsMap.get(foodId);
      if (food) {
        food._recency = timestamp;
        results.push(food);
      }
    }

    // Sort by recency (most recent first) and limit
    return results
      .sort((a, b) => (b._recency || 0) - (a._recency || 0))
      .slice(0, limit)
      .map(food => {
        delete food._recency;
        return food;
      });
  } catch (error) {
    console.error('Error getting recent foods:', error);
    return [];
  }
}

/**
 * Get most frequently logged foods
 * @param {number} [limit=10] - Maximum foods to return
 * @returns {Promise<Array>} Most frequently logged foods
 */
async function getFavoriteFoods(limit = 10) {
  try {
    const meals = await getAll(MEALS_STORE_NAME);

    if (!meals || meals.length === 0) {
      return [];
    }

    // Count occurrences of each foodId
    const foodIdFrequency = new Map();

    for (const meal of meals) {
      if (meal.isDeleted || !meal.items || meal.items.length === 0) {
        continue;
      }

      for (const item of meal.items) {
        if (item.foodId) {
          foodIdFrequency.set(
            item.foodId,
            (foodIdFrequency.get(item.foodId) || 0) + 1
          );
        }
      }
    }

    // Fetch food objects for each unique foodId
    const foods = await getAll(LOCAL_STORE_NAME);
    const foodsMap = new Map();

    if (foods) {
      for (const food of foods) {
        if (!food.isDeleted && food.id) {
          foodsMap.set(food.id, food);
        }
      }
    }

    // Build results with frequency count
    const results = [];

    for (const [foodId, frequency] of foodIdFrequency.entries()) {
      const food = foodsMap.get(foodId);
      if (food) {
        food._frequency = frequency;
        results.push(food);
      }
    }

    // Sort by frequency (most frequent first) and limit
    return results
      .sort((a, b) => (b._frequency || 0) - (a._frequency || 0))
      .slice(0, limit)
      .map(food => {
        delete food._frequency;
        return food;
      });
  } catch (error) {
    console.error('Error getting favorite foods:', error);
    return [];
  }
}

export {
  searchFoods,
  getRecentFoods,
  getFavoriteFoods
};
