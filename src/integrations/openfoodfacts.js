/**
 * Open Food Facts API client
 * Handles food product searches and barcode lookups
 */

import { logIntegrationFailure, requestJSON } from './request.js';

const OFF_BASE_URL = 'https://world.openfoodfacts.org';
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Normalize an Open Food Facts product to LibreLog schema
 * @private
 * @param {Object} product - Raw OFF product object
 * @returns {Object|null} Normalized food object or null if invalid
 */
function normalizeProduct(product) {
  if (!product || !product.product_name) {
    return null;
  }

  try {
    const nutriments = product.nutriments || {};
    const kcal = optionalNumber(nutriments['energy-kcal_100g'])
      ?? (optionalNumber(nutriments.energy_100g) == null
        ? null
        : Math.round(optionalNumber(nutriments.energy_100g) / 4.184));

    return {
      id: `off-${product.code || product.id || Math.random().toString(36).slice(2)}`,
      name: product.product_name || 'Unknown',
      brand: product.brands || '',
      servingSize: {
        quantity: 100,
        unit: 'g'
      },
      nutrients: {
        energy: { kcal },
        macros: {
          protein: { g: optionalNumber(nutriments.proteins_100g) },
          carbs: { g: optionalNumber(nutriments.carbohydrates_100g) },
          fat: { g: optionalNumber(nutriments.fat_100g) }
        },
        fiber: { g: optionalNumber(nutriments.fiber_100g) },
        sodium: {
          // Open Food Facts reports sodium_100g in grams; LibreLog stores mg.
          mg: optionalNumber(nutriments.sodium_100g) == null
            ? null
            : optionalNumber(nutriments.sodium_100g) * 1000
        }
      },
      barcode: {
        ean13: product.code || ''
      },
      source: {
        type: 'openFoodFacts',
        offId: product.id || ''
      },
      category: product.categories || ''
    };
  } catch (error) {
    console.error('Error normalizing OFF product:', error);
    return null;
  }
}

function optionalNumber(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Search for foods using Open Food Facts API
 * @param {string} query - Search query
 * @param {number} [page=1] - Page number for pagination
 * @param {number} [pageSize=20] - Results per page
 * @returns {Promise<Array>} Array of normalized food objects
 */
async function searchFoods(query, page = 1, pageSize = 20, { signal = null } = {}) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  try {
    const url = new URL(`${OFF_BASE_URL}/cgi/search.pl`);
    url.searchParams.set('search_terms', query.trim());
    url.searchParams.set('search_simple', '1');
    url.searchParams.set('action', 'process');
    url.searchParams.set('json', '1');
    url.searchParams.set('page', page.toString());
    url.searchParams.set('page_size', pageSize.toString());

    const { data } = await requestJSON({
      provider: 'Open Food Facts',
      url: url.toString(),
      init: {
        headers: {
          'User-Agent': 'LibreLog/1.0 (librelog@muhprivacy.lol)'
        },
      },
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    });

    if (!data.products || !Array.isArray(data.products)) {
      return [];
    }

    return data.products
      .map(normalizeProduct)
      .filter(product => product !== null);
  } catch (error) {
    logIntegrationFailure(error);
    return [];
  }
}

/**
 * Look up a product by barcode via Open Food Facts API
 * @param {string} barcode - EAN-13 barcode
 * @returns {Promise<Object|null>} Normalized food object or null if not found
 */
async function lookupBarcode(barcode, { signal = null } = {}) {
  if (!barcode || barcode.trim().length === 0) {
    return null;
  }

  try {
    const url = `${OFF_BASE_URL}/api/v0/product/${barcode.trim()}.json`;
    const { data } = await requestJSON({
      provider: 'Open Food Facts',
      url,
      init: {
        headers: {
          'User-Agent': 'LibreLog/1.0 (librelog@muhprivacy.lol)'
        },
      },
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    });

    // OFF API returns status === 1 for successful lookups
    if (data.status !== 1 || !data.product) {
      return null;
    }

    return normalizeProduct(data.product);
  } catch (error) {
    logIntegrationFailure(error);
    return null;
  }
}

export {
  searchFoods,
  lookupBarcode,
  normalizeProduct
};
