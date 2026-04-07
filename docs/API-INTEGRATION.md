# LibreLog API Integration Guide

**Status:** Technical Reference
**Updated:** April 2026

Complete documentation of external API integration patterns, error handling, and caching strategies.

---

## 1. OPEN FOOD FACTS API

### 1.1 Overview

**URL:** `https://world.openfoodfacts.org/api/v2/`
**Rate Limit:** 1 request/second (enforced per-IP)
**Timeout:** 5 seconds
**Cache TTL:** 7 days
**Fallback:** USDA FDC API or cached results

### 1.2 Text Search

**Endpoint:** `GET /search`

**Parameters:**
```javascript
{
  q: String,           // Search query (required)
  countries: String,   // "us,ca,uk" (optional)
  sort_by: String,     // "popularity" | "rating" | "unique_scans"
  page: Number,        // 1-based (default: 1)
  page_size: Number    // 1-50 (default: 20)
}
```

**Example Request:**
```javascript
const query = 'chicken breast';
const url = new URL('https://world.openfoodfacts.org/api/v2/search');
url.searchParams.append('q', query);
url.searchParams.append('countries', 'us');
url.searchParams.append('sort_by', 'popularity');

const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
const data = await response.json();
```

**Response Schema:**
```javascript
{
  count: Number,           // Total results
  page: Number,
  page_size: Number,
  products: [
    {
      id: String,          // Product code (EAN-13)
      code: String,        // Barcode
      product_name: String,
      brands: String,
      image_url: String,   // Front image
      image_small_url: String,
      image_nutrition_url: String,
      quantity: String,    // e.g., "200g"
      countries: [String],
      serving_quantity: Number,
      serving_size: String,
      categories_tags: [String],
      allergens: String,   // Comma-separated
      ingredients: [String],
      energy_kcal_per_100g: Number | null,
      fat_g: Number | null,
      protein_g: Number | null,
      carbohydrates_g: Number | null,
      fiber_g: Number | null,
      sodium_mg: Number | null,
      sugars_g: Number | null,
      // ... 50+ additional fields
    }
  ]
}
```

### 1.3 Barcode Lookup

**Endpoint:** `GET /product/{barcode}`

**Example Request:**
```javascript
async function lookupBarcode(barcode) {
  const response = await fetch(
    `https://world.openfoodfacts.org/api/v2/product/${barcode}`,
    { signal: AbortSignal.timeout(5000) }
  );

  if (!response.ok) {
    return null;  // Product not found
  }

  return response.json();
}
```

**Response Schema:** Same as search products above, but single object.

### 1.4 Response Parsing & Normalization

```javascript
// src/integrations/openFoodFacts.js
export function normalizeOFFProduct(offProduct) {
  return {
    id: generateUuid(),
    name: offProduct.product_name || 'Unknown Food',
    servingSize: {
      quantity: offProduct.serving_quantity || 100,
      unit: offProduct.serving_size?.split(' ')[1] || 'g'
    },
    nutrients: {
      energy: {
        kcal: offProduct.energy_kcal_per_100g ?
          (offProduct.energy_kcal_per_100g * 100 / (offProduct.serving_quantity || 100)) :
          0,
        kJ: offProduct.energy_kj_per_100g ?
          (offProduct.energy_kj_per_100g * 100 / (offProduct.serving_quantity || 100)) :
          0
      },
      macros: {
        protein: {
          g: offProduct.protein_g || 0,
          percent: calculatePercent(offProduct.protein_g,
            offProduct.energy_kcal_per_100g)
        },
        carbs: {
          g: offProduct.carbohydrates_g || 0,
          percent: calculatePercent(offProduct.carbohydrates_g,
            offProduct.energy_kcal_per_100g)
        },
        fat: {
          g: offProduct.fat_g || 0,
          percent: calculatePercent(offProduct.fat_g,
            offProduct.energy_kcal_per_100g)
        }
      },
      fiber: { g: offProduct.fiber_g || 0 },
      sugars: { g: offProduct.sugars_g || 0 },
      sodium: { mg: offProduct.sodium_mg || 0 },
      potassium: { mg: offProduct.potassium_mg || 0 },
      calcium: { mg: offProduct.calcium_mg || 0 },
      iron: { mg: offProduct.iron_mg || 0 }
    },
    source: {
      type: 'openFoodFacts',
      offId: offProduct.code,
      usdaId: null,
      recipeId: null
    },
    barcode: {
      ean13: offProduct.code,
      upc: null,
      alternates: []
    },
    category: offProduct.categories_tags?.[0] || 'Other',
    tags: offProduct.categories_tags || [],
    offMetadata: {
      country: offProduct.countries?.join(', ') || '',
      brand: offProduct.brands || '',
      ingredients: offProduct.ingredients || [],
      allergens: parseAllergens(offProduct.allergens)
    },
    photos: {
      thumbnail: offProduct.image_small_url || offProduct.image_url || '',
      full: offProduct.image_url || ''
    },
    userCreated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null
  };
}

function calculatePercent(grams, kcalPer100g) {
  if (!grams || !kcalPer100g) return 0;
  const kcalFromNutrient = {
    protein: grams * 4,
    carbs: grams * 4,
    fat: grams * 9
  };
  return (kcalFromNutrient / (kcalPer100g * 100)) * 100;
}

function parseAllergens(allergenString) {
  if (!allergenString) return [];
  return allergenString.split(',').map(a => a.trim());
}
```

### 1.5 Caching Strategy

```javascript
// src/integrations/cache.js
export class APICache {
  async getFromOFF(query) {
    // 1. Check local cache
    const cached = await this._getCached('openFoodFacts', query);
    if (cached) return cached;

    // 2. Fetch from API
    if (!navigator.onLine) {
      // Return stale cache if offline
      return cached || null;
    }

    try {
      const results = await fetchOFFSearch(query);
      const normalized = results.products.map(normalizeOFFProduct);

      // 3. Cache results
      await this._cache('openFoodFacts', query, normalized);

      return normalized;
    } catch (error) {
      console.error('OFF API error:', error);
      return cached || null;  // Fallback to stale cache
    }
  }

  async _getCached(apiName, query) {
    const hash = md5(apiName + query);
    const cached = await db.get('apiCache', hash);

    if (!cached) return null;
    if (new Date(cached.expiresAt) < new Date()) {
      // Expired
      await db.delete('apiCache', hash);
      return null;
    }

    // Update hit count
    cached.hitCount = (cached.hitCount || 0) + 1;
    await db.put('apiCache', cached);

    return cached.parsedResult;
  }

  async _cache(apiName, query, result) {
    const hash = md5(apiName + query);
    const ttlMs = apiName === 'openFoodFacts'
      ? 7 * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;

    await db.put('apiCache', {
      id: hash,
      apiName,
      query,
      queryHash: hash,
      response: result,
      parsedResult: result,
      ttl: ttlMs,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      hitCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

function md5(str) {
  // Simple MD5 implementation or use crypto.subtle
  return btoa(str).substring(0, 16);
}
```

### 1.6 Error Handling

```javascript
export async function fetchWithRetry(url, maxRetries = 3) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: {
          'User-Agent': 'LibreLog/1.0 (FLOSS meal tracker)'
        }
      });

      // 2xx: Success
      if (response.ok) {
        return await response.json();
      }

      // 4xx: Client error, don't retry
      if (response.status >= 400 && response.status < 500) {
        console.warn(`API returned ${response.status}: ${response.statusText}`);
        return null;
      }

      // 5xx: Server error, retry
      if (response.status >= 500) {
        lastError = new Error(`Server error: ${response.status}`);
        if (i < maxRetries - 1) {
          await sleep(Math.pow(2, i) * 1000);  // Exponential backoff
          continue;
        }
      }

    } catch (error) {
      // Timeout or network error
      lastError = error;

      // Don't retry on abort (timeout)
      if (error.name === 'AbortError') {
        console.error('Request timeout');
        return null;
      }

      if (i < maxRetries - 1) {
        await sleep(Math.pow(2, i) * 1000);
        continue;
      }
    }
  }

  console.error('API fetch failed after retries:', lastError);
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## 2. USDA FOODDATA CENTRAL API

### 2.1 Overview

**URL:** `https://fdc.nal.usda.gov/api/`
**Authentication:** API key (free tier available)
**Rate Limit:** 100 requests/second
**Timeout:** 10 seconds
**Cache TTL:** 30 days
**Fallback:** Open Food Facts API

### 2.2 Food Search

**Endpoint:** `GET /foods/search`

**Parameters:**
```javascript
{
  query: String,           // Search term (required)
  sort: String,            // "dataType:asc,score:desc"
  pageSize: Number,        // 1-100 (default: 50)
  pageNumber: Number       // 1-based (default: 1)
}
```

**Example Request:**
```javascript
const apiKey = 'your-usda-fdc-api-key';

async function searchUSDA(query) {
  const url = new URL('https://fdc.nal.usda.gov/api/foods/search');
  url.searchParams.append('query', query);
  url.searchParams.append('sort', 'dataType:asc,score:desc');
  url.searchParams.append('pageSize', '20');
  url.searchParams.append('api_key', apiKey);

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return response.json();
}
```

**Response Schema:**
```javascript
{
  foods: [
    {
      fdcId: String,           // Unique ID
      dataType: String,        // "SR_Legacy" | "FanHasDesserts" | "Survey (FNDDS)" etc.
      description: String,     // Full food description
      foodNutrients: [
        {
          nutrient: {
            id: Number,
            number: String,
            name: String,       // "Energy", "Protein", etc.
            unitName: String    // "KCAL", "G", "MG"
          },
          value: Number,
          foodNutrientDerivation: {
            description: String // "Calculated from a known recipe"
          }
        }
      ],
      servingSizeUnit: String, // "g" | "cup" | "piece"
      servingSizeValue: Number,
      householdServingFullText: String, // e.g., "1 cup shredded"
      brandOwner: String,
      ingredients: String,     // Ingredient list (if available)
      publishedDate: String
    }
  ],
  totalHits: Number,
  currentPage: Number,
  pageList: [Number]
}
```

### 2.3 Detailed Food Lookup

**Endpoint:** `GET /foods/{fdcId}`

```javascript
async function getFoodDetails(fdcId) {
  const url = `https://fdc.nal.usda.gov/api/foods/${fdcId}?api_key=${apiKey}`;
  const response = await fetch(url);
  return response.json();
}
```

### 2.4 Response Normalization

```javascript
export function normalizeUSDAFood(usdaFood) {
  // Extract key nutrients
  const nutrients = {};
  const nutrientMap = {
    1003: 'proteinG',
    1005: 'carbG',
    1004: 'fatG',
    1079: 'fiberG',
    1110: 'sodiumMg',
    1106: 'calciumMg',
    1089: 'ironMg'
  };

  usdaFood.foodNutrients.forEach(fn => {
    const key = nutrientMap[fn.nutrient.id];
    if (key) {
      nutrients[key] = fn.value;
    }
  });

  // Calculate energy if not provided
  const kcal = nutrients.proteinG * 4 +
               nutrients.carbG * 4 +
               nutrients.fatG * 9;

  return {
    id: generateUuid(),
    name: usdaFood.description,
    servingSize: {
      quantity: usdaFood.servingSizeValue || 100,
      unit: usdaFood.servingSizeUnit || 'g'
    },
    nutrients: {
      energy: {
        kcal: kcal || 0,
        kJ: (kcal || 0) * 4.184
      },
      macros: {
        protein: { g: nutrients.proteinG || 0 },
        carbs: { g: nutrients.carbG || 0 },
        fat: { g: nutrients.fatG || 0 }
      },
      fiber: { g: nutrients.fiberG || 0 },
      sodium: { mg: nutrients.sodiumMg || 0 },
      calcium: { mg: nutrients.calciumMg || 0 },
      iron: { mg: nutrients.ironMg || 0 }
    },
    source: {
      type: 'usda',
      offId: null,
      usdaId: usdaFood.fdcId,
      recipeId: null
    },
    category: 'USDA Food',
    offMetadata: {
      country: 'United States',
      brand: usdaFood.brandOwner || '',
      ingredients: []
    },
    userCreated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null
  };
}
```

---

## 3. UNIFIED FOOD SEARCH ENGINE

### 3.1 Search Strategy

```javascript
// src/engine/foodSearch.js
export class FoodSearchEngine {
  async search(query, opts = {}) {
    const {
      sources = ['local', 'cache', 'api'],
      limit = 20,
      timeout = 5000
    } = opts;

    const results = [];

    // 1. Search local foods (instant)
    if (sources.includes('local')) {
      const localResults = await this._searchLocal(query);
      results.push(...localResults.slice(0, limit / 2));
    }

    // 2. Search cached API results (fast)
    if (sources.includes('cache')) {
      const cachedResults = await this._searchCache(query);
      results.push(...cachedResults.slice(0, limit / 4));
    }

    // 3. Live API search (if requested or few results)
    if (sources.includes('api') && results.length < limit / 2) {
      const apiResults = await this._searchAPIs(query, { timeout });
      results.push(...apiResults.slice(0, limit / 2));
    }

    // 4. Deduplicate & rank
    return this._deduplicateAndRank(results).slice(0, limit);
  }

  async _searchLocal(query) {
    const foods = await db.getAllWhere('foods', 'name',
      IDBKeyRange.bound(query.toLowerCase(), query.toLowerCase() + '\uffff')
    );

    return foods
      .map(food => ({
        ...food,
        score: this._calculateScore(food, query, 'local')
      }))
      .sort((a, b) => b.score - a.score);
  }

  async _searchCache(query) {
    const hash = md5('all' + query);
    const cached = await db.get('apiCache', hash);

    if (cached && new Date(cached.expiresAt) > new Date()) {
      return cached.parsedResult || [];
    }

    return [];
  }

  async _searchAPIs(query, opts = {}) {
    const [offResults, usdaResults] = await Promise.allSettled([
      new OpenFoodFactsClient().searchByText(query),
      new USDAFdcClient().search(query)
    ]);

    const results = [];

    if (offResults.status === 'fulfilled') {
      results.push(...offResults.value);
    }

    if (usdaResults.status === 'fulfilled') {
      results.push(...usdaResults.value);
    }

    return results;
  }

  _deduplicateAndRank(foods) {
    const seen = new Map();
    const deduped = [];

    foods.forEach(food => {
      // Check for duplicates by name similarity
      let isDuplicate = false;

      for (const [existingName, existing] of seen) {
        if (this._isSimilar(food.name, existingName)) {
          // Keep the one with more complete nutrient data
          if (this._nutrientCompleteness(food) >
              this._nutrientCompleteness(existing)) {
            deduped.splice(deduped.indexOf(existing), 1);
            deduped.push(food);
            seen.set(food.name, food);
          }
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        deduped.push(food);
        seen.set(food.name, food);
      }
    });

    return deduped.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  _calculateScore(food, query, source) {
    let score = 0;

    const q = query.toLowerCase();
    const name = food.name.toLowerCase();

    // Exact match: 100 points
    if (name === q) score = 100;
    // Prefix: 50 points
    else if (name.startsWith(q)) score = 50;
    // Contains: 25 points
    else if (name.includes(q)) score = 25;
    // Fuzzy: 10-20 points
    else score = Math.max(0, 20 - levenshteinDistance(q, name));

    // Boost for recency
    const daysSinceUpdate = (Date.now() - new Date(food.updatedAt)) /
                             (24 * 60 * 60 * 1000);
    if (daysSinceUpdate < 7) score += 5;

    // Boost for popularity
    score += (food.popularity || 0) * 0.5;

    // Source ranking
    if (source === 'local') score += 10;  // Prefer local
    if (source === 'cache') score += 5;   // Then cached
    if (food.source.type === 'custom') score += 3;  // User-created boost

    return score;
  }

  _nutrientCompleteness(food) {
    // Count non-null nutrient fields
    const nutrients = food.nutrients;
    let count = 0;

    ['protein', 'carbs', 'fat', 'fiber', 'sodium', 'calcium', 'iron'].forEach(key => {
      if (nutrients.macros?.[key]?.g !== undefined &&
          nutrients.macros[key].g > 0) count++;
    });

    return count;
  }

  _isSimilar(name1, name2, threshold = 0.8) {
    const dist = levenshteinDistance(
      name1.toLowerCase(),
      name2.toLowerCase()
    );
    const maxLen = Math.max(name1.length, name2.length);
    const similarity = 1 - (dist / maxLen);
    return similarity >= threshold;
  }
}

function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const d = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) d[i][0] = i;
  for (let j = 0; j <= len2; j++) d[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
    }
  }

  return d[len1][len2];
}
```

---

## 4. BARCODE SCANNING

### 4.1 Capacitor Camera Plugin

```javascript
// src/integrations/barcodeScanner.js
import { Camera, CameraResultType } from '@capacitor/camera';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

export async function scanBarcode() {
  try {
    // Request camera permission
    const hasPermission = await checkAndRequestCameraPermission();
    if (!hasPermission) {
      throw new Error('Camera permission denied');
    }

    // Use ML Kit barcode scanner (Android/iOS)
    const { barcodes } = await BarcodeScanner.scan();

    if (barcodes.length === 0) {
      return null;  // User cancelled
    }

    const barcode = barcodes[0];
    return {
      format: barcode.format,  // "EAN_13", "UPC_A", etc.
      value: barcode.rawValue
    };

  } catch (error) {
    console.error('Barcode scan failed:', error);
    throw error;
  }
}

async function checkAndRequestCameraPermission() {
  try {
    const { camera } = await Camera.checkPermissions();

    if (camera === 'prompt') {
      const result = await Camera.requestPermissions();
      return result.camera === 'granted';
    }

    return camera === 'granted';
  } catch (error) {
    return false;
  }
}
```

### 4.2 Barcode Lookup Workflow

```javascript
// src/pages/foodSearch.js
async function onBarcodeScanned(barcode) {
  try {
    // 1. Search local foods by barcode
    let food = await db.getAllWhere('foods', 'ean13', barcode.value);
    if (food.length > 0) {
      return selectFood(food[0]);
    }

    // 2. Check API cache
    food = await apiCache.getByBarcode(barcode.value);
    if (food) {
      return selectFood(food);
    }

    // 3. Fetch from OFF API
    showLoading('Looking up product...');
    food = await openFoodFactsClient.searchByBarcode(barcode.value);

    if (!food) {
      showError('Product not found. You can add it manually.');
      return;
    }

    // 4. Show product details for confirmation
    const confirmed = await showConfirmModal(
      `Is this correct?`,
      `${food.name}\n${food.offMetadata.brand || ''}`,
      food.photos.thumbnail
    );

    if (!confirmed) return;

    // 5. Save to local foods
    await db.put('foods', food);

    // 6. Quick-add portion selection
    selectFood(food);

  } catch (error) {
    showError(`Lookup failed: ${error.message}`);
  }
}
```

---

## 5. API RATE LIMITING

```javascript
// src/integrations/rateLimiter.js
export class RateLimiter {
  constructor(requestsPerSecond = 1) {
    this.requestsPerSecond = requestsPerSecond;
    this.queue = [];
    this.timers = [];
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this._processQueue();
    });
  }

  _processQueue() {
    if (this.queue.length === 0) return;

    const now = Date.now();
    const timeSinceLastRequest = this.timers.length > 0
      ? now - this.timers[this.timers.length - 1]
      : Infinity;

    if (timeSinceLastRequest >= 1000 / this.requestsPerSecond) {
      this.timers.push(now);
      const task = this.queue.shift();
      task();
    } else {
      const delay = (1000 / this.requestsPerSecond) - timeSinceLastRequest;
      setTimeout(() => this._processQueue(), delay);
    }
  }
}

// Usage
const offLimiter = new RateLimiter(1);     // 1 req/sec
const usdaLimiter = new RateLimiter(2);    // 2 req/sec

async function searchOFF(query) {
  return offLimiter.execute(() => fetchOFFAPI(query));
}
```

---

## 6. ERROR RECOVERY & FALLBACKS

```javascript
// src/integrations/fallback.js
export class APIFallbackStrategy {
  async getFood(foodId, sources = ['local', 'cache', 'off', 'usda']) {
    for (const source of sources) {
      try {
        switch (source) {
          case 'local':
            return await this._getFromLocal(foodId);
          case 'cache':
            return await this._getFromCache(foodId);
          case 'off':
            return await this._getFromOFF(foodId);
          case 'usda':
            return await this._getFromUSDA(foodId);
        }
      } catch (error) {
        console.warn(`Fallback: ${source} failed, trying next...`, error);
      }
    }

    throw new Error('All sources exhausted');
  }

  async _getFromOFF(foodId) {
    const food = await new OpenFoodFactsClient().getProduct(foodId);
    if (!food) throw new Error('Not found in OFF');
    return food;
  }

  async _getFromUSDA(query) {
    const foods = await new USDAFdcClient().search(query);
    if (foods.length === 0) throw new Error('Not found in USDA');
    return foods[0];
  }

  async _getFromLocal(foodId) {
    const food = await db.get('foods', foodId);
    if (!food) throw new Error('Not in local DB');
    return food;
  }

  async _getFromCache(foodId) {
    const cached = await db.get('apiCache', foodId);
    if (!cached || new Date(cached.expiresAt) < new Date()) {
      throw new Error('Cache miss or expired');
    }
    return cached.parsedResult;
  }
}
```

---

This integration guide provides:
- Complete API documentation
- Normalization/parsing code
- Caching strategies
- Error handling patterns
- Fallback logic
- Rate limiting
- Offline support
