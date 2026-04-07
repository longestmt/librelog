/**
 * USDA FoodData Central API client
 * Handles food searches and FDC ID lookups
 */

import { getSetting } from '../data/db.js';

const USDA_BASE_URL = 'https://api.nal.usda.gov/fdc/v1';
const REQUEST_TIMEOUT_MS = 8000;

/** USDA nutrient ID mapping */
const NUTRIENT_IDS = {
  ENERGY: 1008,
  ENERGY_ATWATER_GENERAL: 2047,
  ENERGY_ATWATER_SPECIFIC: 2048,
  PROTEIN: 1003,
  TOTAL_FAT: 1004,
  CARBS: 1005,
  FIBER: 1079,
  SODIUM: 1093
};

/**
 * Extract a nutrient value from USDA foodNutrients array by nutrient ID
 * @private
 * @param {Array} foodNutrients - Array of nutrient objects
 * @param {number} nutrientId - USDA nutrient number
 * @returns {number} Nutrient value or 0
 */
function getNutrientValue(foodNutrients, nutrientId) {
  if (!Array.isArray(foodNutrients)) {
    return 0;
  }

  const nutrient = foodNutrients.find(
    n => (n.nutrientId || (n.nutrient && n.nutrient.id)) === nutrientId
  );

  if (!nutrient) {
    return 0;
  }

  return nutrient.value ?? nutrient.amount ?? 0;
}

/**
 * Normalize a USDA FDC food item to LibreLog schema
 * @param {Object} food - Raw USDA food object
 * @returns {Object|null} Normalized food object or null if invalid
 */
function normalizeFood(food) {
  if (!food || !food.description) {
    return null;
  }

  try {
    const fdcId = food.fdcId;
    const nutrients = food.foodNutrients || [];

    return {
      id: `usda-${fdcId}`,
      name: food.description,
      brand: food.brandName || '',
      servingSize: {
        quantity: 100,
        unit: 'g'
      },
      nutrients: {
        energy: {
          kcal: getNutrientValue(nutrients, NUTRIENT_IDS.ENERGY)
            || getNutrientValue(nutrients, NUTRIENT_IDS.ENERGY_ATWATER_GENERAL)
            || getNutrientValue(nutrients, NUTRIENT_IDS.ENERGY_ATWATER_SPECIFIC)
        },
        macros: {
          protein: {
            g: getNutrientValue(nutrients, NUTRIENT_IDS.PROTEIN)
          },
          carbs: {
            g: getNutrientValue(nutrients, NUTRIENT_IDS.CARBS)
          },
          fat: {
            g: getNutrientValue(nutrients, NUTRIENT_IDS.TOTAL_FAT)
          }
        },
        fiber: {
          g: getNutrientValue(nutrients, NUTRIENT_IDS.FIBER)
        },
        sodium: {
          mg: getNutrientValue(nutrients, NUTRIENT_IDS.SODIUM)
        }
      },
      source: {
        type: 'usda',
        fdcId
      },
      category: food.foodCategory || ''
    };
  } catch (error) {
    console.error('Error normalizing USDA food:', error);
    return null;
  }
}

/**
 * Search for foods using USDA FoodData Central API
 * @param {string} query - Search query
 * @param {number} [page=1] - Page number for pagination
 * @param {number} [pageSize=20] - Results per page
 * @returns {Promise<Array>} Array of normalized food objects
 */
async function searchFoods(query, page = 1, pageSize = 20) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const apiKey = await getSetting('usda_api_key');
  if (!apiKey) {
    console.warn('USDA API key not configured');
    return [];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(`${USDA_BASE_URL}/foods/search`);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('query', query.trim());
    url.searchParams.set('pageNumber', page.toString());
    url.searchParams.set('pageSize', pageSize.toString());
    url.searchParams.set('dataType', 'Foundation,SR Legacy');

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LibreLog/1.0 (librelog@muhprivacy.lol)'
      }
    });

    if (!response.ok) {
      console.warn(`USDA search returned status ${response.status}`);
      return [];
    }

    const data = await response.json();

    if (!data.foods || !Array.isArray(data.foods)) {
      return [];
    }

    return data.foods
      .map(normalizeFood)
      .filter(food => food !== null);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('USDA search timeout');
    } else {
      console.error('Error searching USDA:', error);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Look up a food by FDC ID via USDA FoodData Central API
 * @param {string|number} fdcId - FDC ID
 * @returns {Promise<Object|null>} Normalized food object or null if not found
 */
async function lookupFdcId(fdcId) {
  if (!fdcId) {
    return null;
  }

  const apiKey = await getSetting('usda_api_key');
  if (!apiKey) {
    console.warn('USDA API key not configured');
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(`${USDA_BASE_URL}/food/${fdcId}`);
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LibreLog/1.0 (librelog@muhprivacy.lol)'
      }
    });

    if (!response.ok) {
      console.warn(`USDA FDC lookup returned status ${response.status}`);
      return null;
    }

    const data = await response.json();

    return normalizeFood(data);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('USDA FDC lookup timeout');
    } else {
      console.error('Error looking up USDA FDC ID:', error);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export {
  searchFoods,
  lookupFdcId,
  normalizeFood
};
