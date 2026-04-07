/**
 * Open Food Facts API client
 * Handles food product searches and barcode lookups
 */

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

    return {
      id: `off-${product.code || product.id || Math.random().toString(36).slice(2)}`,
      name: product.product_name || 'Unknown',
      brand: product.brands || '',
      servingSize: {
        quantity: 100,
        unit: 'g'
      },
      nutrients: {
        energy: {
          kcal: (nutriments['energy-kcal_100g'] ?? null) !== null
            ? nutriments['energy-kcal_100g']
            : Math.round((nutriments['energy_100g'] ?? 0) / 4.184)
        },
        macros: {
          protein: {
            g: nutriments.proteins_100g ?? 0
          },
          carbs: {
            g: nutriments.carbohydrates_100g ?? 0
          },
          fat: {
            g: nutriments.fat_100g ?? 0
          }
        },
        fiber: {
          g: nutriments.fiber_100g ?? 0
        },
        sodium: {
          mg: nutriments.sodium_100g != null ? nutriments.sodium_100g * 10 : 0
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

/**
 * Search for foods using Open Food Facts API
 * @param {string} query - Search query
 * @param {number} [page=1] - Page number for pagination
 * @param {number} [pageSize=20] - Results per page
 * @returns {Promise<Array>} Array of normalized food objects
 */
async function searchFoods(query, page = 1, pageSize = 20) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(`${OFF_BASE_URL}/cgi/search.pl`);
    url.searchParams.set('search_terms', query.trim());
    url.searchParams.set('search_simple', '1');
    url.searchParams.set('action', 'process');
    url.searchParams.set('json', '1');
    url.searchParams.set('page', page.toString());
    url.searchParams.set('page_size', pageSize.toString());

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LibreLog/1.0'
      }
    });

    if (!response.ok) {
      console.warn(`OFF search returned status ${response.status}`);
      return [];
    }

    const data = await response.json();

    if (!data.products || !Array.isArray(data.products)) {
      return [];
    }

    return data.products
      .map(normalizeProduct)
      .filter(product => product !== null);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('OFF search timeout');
    } else {
      console.error('Error searching OFF:', error);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Look up a product by barcode via Open Food Facts API
 * @param {string} barcode - EAN-13 barcode
 * @returns {Promise<Object|null>} Normalized food object or null if not found
 */
async function lookupBarcode(barcode) {
  if (!barcode || barcode.trim().length === 0) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${OFF_BASE_URL}/api/v0/product/${barcode.trim()}.json`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LibreLog/1.0'
      }
    });

    if (!response.ok) {
      console.warn(`OFF barcode lookup returned status ${response.status}`);
      return null;
    }

    const data = await response.json();

    // OFF API returns status === 1 for successful lookups
    if (data.status !== 1 || !data.product) {
      return null;
    }

    return normalizeProduct(data.product);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('OFF barcode lookup timeout');
    } else {
      console.error('Error looking up OFF barcode:', error);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export {
  searchFoods,
  lookupBarcode,
  normalizeProduct
};
