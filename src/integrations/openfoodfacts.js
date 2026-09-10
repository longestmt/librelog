/**
 * Open Food Facts API client
 * Handles food product searches and barcode lookups
 */

import { logIntegrationFailure, requestJSON } from './request.js';
import { newId } from '../data/identity.js';

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
    const servingQuantity = optionalPositiveNumber(product.serving_quantity);
    const servingLabel = typeof product.serving_size === 'string'
      ? product.serving_size.trim()
      : '';
    const servingKcal = getEnergyKcal(nutriments, 'serving');
    // OFF's *_serving fields are already normalized for exactly one serving.
    // Require both normalized quantity and the package's human-readable label;
    // otherwise retain the unambiguous 100 g basis.
    const useServingBasis = servingQuantity !== null
      && servingLabel.length > 0
      && servingKcal !== null;
    const suffix = useServingBasis ? 'serving' : '100g';
    const quantityUnit = String(product.serving_quantity_unit || '').toLowerCase();
    const servingSize = useServingBasis
      ? {
          quantity: 1,
          unit: 'serving',
          label: servingLabel,
          packageQuantity: servingQuantity,
          packageUnit: ['g', 'ml'].includes(quantityUnit) ? quantityUnit : null,
          // Only expose mass conversion when OFF explicitly identifies grams.
          ...(quantityUnit === 'g' ? { gramsPerUnit: servingQuantity } : {}),
        }
      : { quantity: 100, unit: 'g' };

    return {
      id: product.code || product.id ? `off-${product.code || product.id}` : newId(),
      name: product.product_name || 'Unknown',
      brand: product.brands || '',
      servingSize,
      nutrients: {
        energy: { kcal: getEnergyKcal(nutriments, suffix) },
        macros: {
          protein: { g: optionalNumber(nutriments[`proteins_${suffix}`]) },
          carbs: { g: optionalNumber(nutriments[`carbohydrates_${suffix}`]) },
          fat: { g: optionalNumber(nutriments[`fat_${suffix}`]) }
        },
        fiber: { g: optionalNumber(nutriments[`fiber_${suffix}`]) },
        sodium: {
          // Open Food Facts reports normalized sodium in grams; LibreLog stores mg.
          mg: optionalNumber(nutriments[`sodium_${suffix}`]) == null
            ? null
            : optionalNumber(nutriments[`sodium_${suffix}`]) * 1000
        }
      },
      barcode: {
        ean13: product.code || ''
      },
      source: {
        type: 'openFoodFacts',
        offId: product.id || '',
        nutritionBasis: useServingBasis ? 'serving' : '100g',
      },
      category: product.categories || ''
    };
  } catch (error) {
    console.error('Error normalizing OFF product:', error);
    return null;
  }
}

function getEnergyKcal(nutriments, suffix) {
  return optionalNumber(nutriments[`energy-kcal_${suffix}`])
    ?? (optionalNumber(nutriments[`energy_${suffix}`]) == null
      ? null
      : Math.round(optionalNumber(nutriments[`energy_${suffix}`]) / 4.184));
}

function optionalNumber(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function optionalPositiveNumber(value) {
  const number = optionalNumber(value);
  return number !== null && number > 0 ? number : null;
}

/**
 * Search for foods using Open Food Facts API
 * @param {string} query - Search query
 * @param {number} [page=1] - Page number for pagination
 * @param {number} [pageSize=20] - Results per page
 * @returns {Promise<Array>} Array of normalized food objects
 */
async function searchFoods(query, page = 1, pageSize = 20, {
  signal = null,
  throwOnError = false,
} = {}) {
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
      consentKey: 'openfoodfacts',
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
    if (throwOnError) throw error;
    return [];
  }
}

/**
 * Look up a product by barcode via Open Food Facts API
 * @param {string} barcode - EAN-13 barcode
 * @returns {Promise<Object|null>} Normalized food object or null if not found
 */
async function lookupBarcode(barcode, { signal = null, throwOnError = false } = {}) {
  if (!barcode || barcode.trim().length === 0) {
    return null;
  }

  try {
    const url = `${OFF_BASE_URL}/api/v0/product/${barcode.trim()}.json`;
    const { data } = await requestJSON({
      provider: 'Open Food Facts',
      consentKey: 'openfoodfacts',
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
    if (throwOnError) throw error;
    return null;
  }
}

export {
  searchFoods,
  lookupBarcode,
  normalizeProduct
};
