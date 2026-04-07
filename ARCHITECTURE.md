# LibreLog Technical Architecture

**Version:** 1.0
**Date:** April 2026
**Status:** Design Specification
**Alignment:** LibreLift v1.0+ (Vanilla JS + Vite + Capacitor)

---

## 1. SYSTEM ARCHITECTURE

### 1.1 Module Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         LibreLog SPA                         │
│                    (Vanilla JS + Vite 6.1)                  │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────▼────┐          ┌─────▼────┐         ┌─────▼────┐
   │ Router  │          │ Auth &   │         │  State   │
   │(Hash)   │          │ Security │         │  (Mem)   │
   └────┬────┘          └──────────┘         └──────────┘
        │
    ┌───┴──────────────────────────────────┐
    │                                      │
    │      ┌────────────────────────┐     │
    │      │   Pages/Components     │     │
    │      ├────────────────────────┤     │
    │      │ • Diary (home)         │     │
    │      │ • Food Search          │     │
    │      │ • Meal Builder         │     │
    │      │ • Goals/Nutrition      │     │
    │      │ • Settings             │     │
    │      │ • Weight Tracker       │     │
    │      │ • Recipe Library       │     │
    │      │ • AI Chat (optional)   │     │
    │      └────────────────────────┘     │
    │                │                     │
    └────────────────┼─────────────────────┘
                     │
     ┌───────────────┼────────────────┐
     │               │                │
┌────▼───────┐ ┌────▼──────┐ ┌──────▼──────┐
│  Data      │ │  Engine   │ │  External   │
│  Layer     │ │  (Logic)  │ │  Integrations
├────────────┤ ├───────────┤ ├─────────────┤
│ • db.js    │ │ • Meal    │ │ • Open Food │
│ • IndexedDB│ │   calc    │ │   Facts API │
│ • Sync     │ │ • Goal    │ │ • USDA FDC  │
│ • Import   │ │   tracking│ │ • AI (BYOK) │
│ • Export   │ │ • Search  │ │ • WebDAV    │
└────────────┘ └───────────┘ └─────────────┘
     │               │                │
     └───────────────┼────────────────┘
                     │
           ┌─────────┴──────────┐
           │                    │
      ┌────▼────┐          ┌────▼────┐
      │  PWA &  │          │ Native  │
      │ Service │          │(Capacitor
      │ Worker  │          │ iOS/Android)
      └─────────┘          └─────────┘
```

### 1.2 Directory Structure

```
librelog/
├── src/
│   ├── app.js                    # SPA entry, router, auth check
│   ├── index.html                # PWA manifest, meta tags
│   ├── manifest.webmanifest      # PWA manifest
│   │
│   ├── pages/
│   │   ├── diary.js              # Daily log, food entry UI
│   │   ├── foodSearch.js          # API search, barcode, custom foods
│   │   ├── mealBuilder.js         # Recipe builder, meal templates
│   │   ├── goals.js              # Nutrition goals, tracking
│   │   ├── settings.js           # App settings, integrations, BYOK
│   │   ├── weightTracker.js       # Body measurements, weight
│   │   ├── recipes.js            # Saved recipes, templates
│   │   ├── aiChat.js             # AI food analysis (optional)
│   │   └── about.js              # Credits, privacy, licenses
│   │
│   ├── components/
│   │   ├── nutritionCard.js       # Macro/micro display widget
│   │   ├── mealCard.js            # Single meal render
│   │   ├── foodSearch.js          # Reusable search component
│   │   ├── barcodeScan.js         # Camera/barcode input
│   │   ├── recipeListing.js       # Recipe template list
│   │   ├── nutritionTable.js       # Detailed nutrient breakdown
│   │   ├── chart.js              # Charts (canvas-based)
│   │   ├── modal.js              # Modal dialog wrapper
│   │   ├── tabs.js               # Tab navigation
│   │   └── loadingSpinner.js      # Loading indicator
│   │
│   ├── data/
│   │   ├── db.js                 # IndexedDB wrapper (CRUD)
│   │   ├── schema.js             # DB schema + migration logic
│   │   ├── state.js              # In-memory state + caching
│   │   ├── import-export.js       # JSON/CSV import/export
│   │   ├── webdav.js             # WebDAV sync (optional)
│   │   ├── seedData.js           # Default foods, exercises
│   │   └── sync.js               # Conflict resolution, delta sync
│   │
│   ├── engine/
│   │   ├── nutrition.js           # Macro/micro calculations
│   │   ├── goalTracking.js        # Goal progress, alerts
│   │   ├── foodSearch.js          # Search logic, ranking
│   │   ├── mealCalculator.js      # Meal composition, quantities
│   │   ├── recipeMachine.js       # Recipe scaling, cloning
│   │   ├── weightAnalysis.js      # Trend, BMI, calorie adjustments
│   │   └── validation.js          # Data validation rules
│   │
│   ├── integrations/
│   │   ├── openFoodFacts.js       # OFF API client + cache
│   │   ├── usdaFdc.js             # USDA FDC API client
│   │   ├── aiClient.js            # LLM routing (OpenAI/Anthropic/Ollama)
│   │   ├── imageProcessor.js       # Photo analysis prompt + parsing
│   │   ├── voiceParser.js         # Voice transcription → meal parsing
│   │   └── cache.js               # API response caching + TTL
│   │
│   ├── utils/
│   │   ├── format.js              # Number, date, nutrition formatting
│   │   ├── storage.js             # Secure localStorage (BYOK keys)
│   │   ├── haptics.js             # Vibration feedback (Capacitor)
│   │   ├── sanitize.js            # HTML/input sanitization
│   │   ├── validation.js          # Input validation helpers
│   │   ├── error.js               # Error handling, telemetry stubs
│   │   └── debug.js               # Dev logging (env-gated)
│   │
│   └── styles/
│       ├── index.css              # Global styles, CSS variables
│       ├── components.css         # Component-scoped styles
│       ├── themes.css             # Light/dark mode
│       └── responsive.css         # Mobile-first breakpoints
│
├── vite.config.js                # Vite + PWA config
├── package.json
├── capacitor.config.json          # Capacitor native config
│
├── docs/
│   ├── API-INTEGRATION.md         # Detailed API docs
│   ├── SECURITY.md                # Encryption, BYOK, data safety
│   ├── DATA-BACKUP.md             # Backup strategies
│   └── DEPLOYMENT.md              # Build, native, PWA deployment
│
└── ARCHITECTURE.md (this file)
```

### 1.3 Alignment with LibreLift

| Aspect | LibreLift | LibreLog | Alignment |
|--------|-----------|---------|-----------|
| **Framework** | Vanilla JS (ES modules) | Vanilla JS (ES modules) | Full ✓ |
| **Build** | Vite 6.1.0 | Vite 6.1.0 | Full ✓ |
| **Storage** | IndexedDB + UUID | IndexedDB + UUID | Full ✓ |
| **Routing** | Hash-based (`app.js`) | Hash-based (`app.js`) | Full ✓ |
| **Components** | Reusable modules in `src/components/` | Same pattern | Full ✓ |
| **PWA** | vite-plugin-pwa + Workbox | vite-plugin-pwa + Workbox | Full ✓ |
| **Mobile** | Capacitor 8.1.0 | Capacitor 8.1.0 | Full ✓ |
| **License** | AGPL-3.0 | AGPL-3.0 | Full ✓ |
| **Sync** | WebDAV + Gist backup | WebDAV + Gist backup | Full ✓ |

---

## 2. DATA MODEL

### 2.1 IndexedDB Schema

All tables use UUID v4 primary keys with `createdAt`/`updatedAt` timestamps and soft-delete support (`deletedAt`).

#### 2.1.1 `users` Table
Singleton or per-device profile. Stores nutrition goals, AI preferences, app state.

```javascript
{
  id: UUID,                              // Single record (fixed ID: "user-1")
  profile: {
    name: String,
    age: Number,
    gender: "M" | "F" | "Other",
    heightCm: Number,
    startDate: ISO8601,
    timezone: String                     // "America/New_York"
  },
  goals: {
    calorieTarget: Number,               // kcal/day
    macroTargets: {
      proteinG: Number,
      carbG: Number,
      fatG: Number
    },
    microTargets: {
      fiberG: Number,
      sodiumMg: Number,
      waterL: Number
      // ... other key micronutrients
    },
    trackingMode: "calories" | "macros" | "detailed",
    activityLevel: "sedentary" | "light" | "moderate" | "active" | "veryActive"
  },
  integrations: {
    openFoodFactsEnabled: Boolean,
    usdaFdcEnabled: Boolean,
    byokEnabled: Boolean,
    byokProvider: "openai" | "anthropic" | "ollama" | null,
    webdavEnabled: Boolean,
    webdavUrl: String,                   // Encrypted
    webdavUsername: String               // Encrypted
  },
  aiSettings: {
    byokProvider: "openai" | "anthropic" | "ollama" | null,
    modelName: String,                   // "gpt-4", "claude-opus", "ollama-model"
    photoParsing: Boolean,               // Enable photo-based food ID
    voiceParsing: Boolean,               // Enable voice meal parsing
    autoSuggest: Boolean,                // Suggest meals based on history + goals
    voiceProvider: "openai" | "google" | null  // For STT
  },
  privacy: {
    shareData: Boolean,                  // Anonymized aggregates to Libre project
    allowAnalytics: Boolean
  },
  theme: "light" | "dark" | "auto",
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

#### 2.1.2 `foods` Table
Unified food catalog: custom entries + API-sourced + user recipes stored as foods.

```javascript
{
  id: UUID,
  name: String,                          // "Chicken Breast (skinless, cooked)"
  description: String,                   // User notes
  servingSize: {
    quantity: Number,                    // 100
    unit: String                         // "g", "oz", "cup", "tbsp", "piece"
  },
  servingAliases: [                      // Alternative serving sizes
    { quantity: 1, unit: "piece", quantityInBaseUnit: 180 },
    { quantity: 3.5, unit: "oz", quantityInBaseUnit: 100 }
  ],
  nutrients: {
    energy: { kcal: Number, kJ: Number },
    macros: {
      protein: { g: Number, percent: Number },
      carbs: { g: Number, percent: Number },
      fat: { g: Number, percent: Number }
    },
    fiber: { g: Number },
    sugars: { g: Number },
    sodium: { mg: Number },
    potassium: { mg: Number },
    calcium: { mg: Number },
    iron: { mg: Number },
    magnesium: { mg: Number },
    phosphorus: { mg: Number },
    zinc: { mg: Number },
    vitamins: {
      vitaminA: { mcg: Number },
      vitaminC: { mg: Number },
      vitaminD: { mcg: Number },
      vitaminE: { mg: Number },
      vitaminK: { mcg: Number },
      vitaminB12: { mcg: Number },
      folate: { mcg: Number }
    }
  },
  source: {
    type: "custom" | "openFoodFacts" | "usda" | "recipe",
    offId: String | null,                // Open Food Facts product code
    usdaId: String | null,                // USDA FDC ID
    recipeId: UUID | null                // Reference to recipe (if type="recipe")
  },
  barcode: {
    ean13: String | null,
    upc: String | null,
    alternates: [String]
  },
  category: String,                      // "Dairy", "Meat", "Vegetables"
  tags: [String],                        // ["organic", "keto-friendly"]
  density: Number | null,                // g/ml for liquid items
  photos: {
    thumbnail: String,                   // Base64 or CDN URL
    full: String
  },
  offMetadata: {                         // Cache from Open Food Facts
    country: String,
    brand: String,
    ingredients: [String]
  },
  popularity: Number,                    // User search/use frequency
  searchBoost: Number,                   // Manual ranking multiplier
  userCreated: Boolean,                  // User added vs. API-sourced
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

#### 2.1.3 `meals` Table
Meal entries in the daily diary.

```javascript
{
  id: UUID,
  userId: UUID,                          // Reference to user (future: multi-device)
  date: "2026-04-06",                    // YYYY-MM-DD for fast daily queries
  mealType: "breakfast" | "lunch" | "dinner" | "snack" | "other",
  name: String,                          // User-facing: "Chicken Caesar Salad"
  time: "09:30" | null,                  // HH:MM, optional
  items: [                                // Foods + quantities
    {
      id: UUID,                          // Unique per meal (for ordering)
      foodId: UUID,
      quantity: Number,                  // 150
      unit: String,                      // "g"
      notes: String,                     // "fried in olive oil"
      aiFlagReason: String | null        // "portion estimated from photo"
    }
  ],
  totals: {                              // Cached calorie/macro totals
    kcal: Number,
    macros: { proteinG: Number, carbG: Number, fatG: Number },
    fiber: Number,
    sodium: Number
  },
  source: {
    type: "manual" | "recipe" | "ai" | "voice" | "barcode",
    recipeId: UUID | null,
    aiImagePath: String | null,          // Stored image from photo analysis
    transcription: String | null         // Voice input text
  },
  metadata: {
    photoUrls: [String],                 // User-provided meal photos
    location: String | null,             // "Restaurant name", if tracked
    companions: [String] | null          // Social context
  },
  tags: [String],                        // ["at-home", "meal-prep"]
  notes: String,                         // User notes
  validated: Boolean,                    // AI-flagged items reviewed?
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

#### 2.1.4 `recipes` Table
Saved meal templates (reusable blueprints).

```javascript
{
  id: UUID,
  name: String,                          // "Overnight Oats"
  description: String,
  servings: Number,                      // Total yield of recipe
  items: [
    {
      id: UUID,
      foodId: UUID,
      quantity: Number,
      unit: String,
      notes: String
    }
  ],
  totals: {                              // Per serving
    kcal: Number,
    macros: { proteinG: Number, carbG: Number, fatG: Number },
    micronutrients: { ... }
  },
  instructions: String,                  // Preparation steps (markdown)
  category: String,                      // "Breakfast", "Snack", "Meal Prep"
  tags: [String],
  difficulty: "easy" | "medium" | "hard",
  prepTimeMin: Number,
  cookTimeMin: Number,
  nutritionPerServing: { ... },          // Auto-calculated from items
  photos: {
    thumbnail: String,
    full: [String]
  },
  source: {
    type: "user" | "shared" | "api",
    authorId: UUID | null,
    publicUrl: String | null             // Future: share recipes
  },
  frequency: Number,                     // Times logged
  favorites: Boolean,
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

#### 2.1.5 `measurements` Table
Body metrics for tracking progress (weight, body composition, measurements).

```javascript
{
  id: UUID,
  date: "2026-04-06",                    // YYYY-MM-DD
  type: "weight" | "measurement" | "composition",
  value: Number,                         // kg for weight, cm for measurements
  unit: "kg" | "lb" | "cm" | "inch",
  bodyPart: String | null,               // "waist", "chest", "arm" (if measurement)
  notes: String,
  method: "scale" | "manual" | "device",
  confidence: 0.5 | 1.0,                 // 1.0 = high confidence
  bodyComposition: {                     // If type="composition"
    bodyFatPercent: Number | null,
    muscleMassKg: Number | null,
    waterPercent: Number | null
  },
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

#### 2.1.6 `aiConversations` Table
Cache of AI requests/responses (only if BYOK enabled, optional).

```javascript
{
  id: UUID,
  type: "photo-analysis" | "voice-parsing" | "meal-suggestion" | "question",
  userInput: {
    text: String | null,
    imageBase64: String | null,          // Stored temporarily during analysis
    audioTranscription: String | null
  },
  aiResponse: {
    foods: [
      {
        name: String,
        confidence: 0.0 | 1.0,
        quantity: Number,
        unit: String,
        reason: String
      }
    ],
    alternatives: [String],              // "Could also be..."
    followUpQuestions: [String],
    rawResponse: String                  // Full LLM response (for debugging)
  },
  tokens: {
    inputTokens: Number,
    outputTokens: Number,
    estimatedCost: Number                // USD
  },
  status: "pending" | "success" | "error",
  error: String | null,
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

#### 2.1.7 `syncLog` Table
Tracks WebDAV/sync state for offline-first + conflict resolution.

```javascript
{
  id: UUID,
  entityType: "meals" | "foods" | "recipes" | "measurements" | "users",
  entityId: UUID,
  operation: "create" | "update" | "delete",
  localVersion: Number,                  // Incremental version
  remoteVersion: Number | null,
  status: "pending" | "synced" | "conflict" | "error",
  lastSyncAt: ISO8601 | null,
  conflict: {
    resolved: Boolean,
    strategy: "local" | "remote" | "merge",
    mergeDetails: Object | null
  },
  createdAt: ISO8601,
  updatedAt: ISO8601
}
```

#### 2.1.8 `apiCache` Table
Caching layer for external API responses.

```javascript
{
  id: UUID,                              // Hash of query
  apiName: "openFoodFacts" | "usdaFdc",
  query: String,                         // Original search term or ID
  queryHash: String,                     // MD5(apiName + query) for dedup
  response: Object,                      // Full API response (JSON)
  parsedResult: Object,                  // Normalized to food schema
  ttl: Number,                           // Milliseconds (OFF: 7 days, USDA: 30 days)
  expiresAt: ISO8601,
  hitCount: Number,                      // Cache hit tracking
  createdAt: ISO8601,
  updatedAt: ISO8601
}
```

### 2.2 Database Indexes

```javascript
// Optimized for common queries
db.createIndex('meals', 'date');         // Daily diary queries
db.createIndex('meals', 'userId');        // Multi-device support
db.createIndex('foods', 'name');         // Food search autocomplete
db.createIndex('foods', 'barcode.ean13'); // Barcode lookup
db.createIndex('foods', 'source.type');  // Filter custom vs API
db.createIndex('measurements', 'date');  // Weight trend queries
db.createIndex('apiCache', 'expiresAt'); // Cache expiry cleanup
db.createIndex('syncLog', 'status');     // Pending sync queries
db.createIndex('apiCache', 'queryHash'); // Dedup API requests
```

### 2.3 Data Migration & Schema Versioning

```javascript
// src/data/schema.js
const SCHEMA_VERSION = 1;

export const migrations = {
  0: {                                   // Initial schema
    stores: ['users', 'foods', 'meals', 'recipes', 'measurements',
             'aiConversations', 'syncLog', 'apiCache']
  },
  1: {                                   // v1.1: Add confidence field to measurements
    upgrade: async (db) => {
      const measurements = await db.getAll('measurements');
      for (const m of measurements) {
        m.confidence = m.confidence ?? 1.0;
        await db.put('measurements', m);
      }
    }
  }
  // Future versions...
};

export async function ensureSchema(db) {
  const version = await db.get('_schema', 'version');
  if (!version) {
    // Initial setup
    for (const [_, migration] of Object.entries(migrations)) {
      if (migration.stores) {
        for (const store of migration.stores) {
          await db.createObjectStore(store, { keyPath: 'id' });
        }
      }
    }
    await db.put('_schema', { id: 'version', value: SCHEMA_VERSION });
  } else if (version.value < SCHEMA_VERSION) {
    // Run pending migrations
    for (let v = version.value + 1; v <= SCHEMA_VERSION; v++) {
      await migrations[v].upgrade?.(db);
    }
  }
}
```

---

## 3. API INTEGRATION LAYER

### 3.1 Open Food Facts Integration

**Base URL:** `https://world.openfoodfacts.org/api/v2/`

#### Search by Text
```javascript
// GET /search?q=chicken&countries=us&sort_by=popularity
// Returns: foods with photos, nutrients, ingredients
```

#### Search by Barcode
```javascript
// GET /product/{barcode}
// Returns: single product with full nutrition facts, ingredients, country
```

#### Caching Strategy
- **TTL:** 7 days (products updated weekly)
- **Dedup:** MD5 hash of (source + barcode/query)
- **Expiry:** Auto-cleanup via background task
- **Offline:** Return cached if network unavailable

#### Integration Code Structure
```javascript
// src/integrations/openFoodFacts.js
export class OpenFoodFactsClient {
  async searchByText(query, opts = {}) {
    // 1. Check apiCache for exact match
    // 2. If miss, fetch from OFF API
    // 3. Normalize to food schema
    // 4. Store in apiCache with 7-day TTL
    // 5. Return parsed result
  }

  async searchByBarcode(barcode) {
    // Similar flow, indexed by barcode
  }

  async getProduct(productId) {
    // Direct product ID lookup
  }
}
```

### 3.2 USDA FoodData Central Integration

**Base URL:** `https://fdc.nal.usda.gov/api/`

#### Search Foods
```javascript
// GET /foods/search?query=chicken&sort=dataType:asc,score:desc
// Returns: SR Legacy foods + USDA branded products
```

#### Get Nutrient Details
```javascript
// GET /foods/{fdcId}
// Returns: 150+ nutrients, daily value, footnotes
```

#### Caching Strategy
- **TTL:** 30 days (USDA data changes slowly)
- **Fallback:** Used when OFF search yields poor results
- **Linking:** Both APIs can return same item; deduplicate by nutrient match

#### Integration Code Structure
```javascript
// src/integrations/usdaFdc.js
export class USDAFdcClient {
  async search(query, opts = {}) {
    // Check cache, fetch, normalize, cache (30 days)
  }

  async getFood(fdcId) {
    // Detailed nutrient retrieval
  }

  async searchByNutrient(nutrient, range) {
    // Advanced: find foods high in specific nutrient
  }
}
```

### 3.3 Unified Food Search Engine

```javascript
// src/engine/foodSearch.js
export class FoodSearchEngine {
  async search(query, opts = {}) {
    // 1. Query local foods (IndexedDB) - instant
    // 2. Query apiCache (local OFF/USDA responses) - fast
    // 3. If few results OR user opts for "full search":
    //    - Parallel fetch: OFF + USDA APIs
    //    - Merge results, deduplicate by nutrient similarity
    //    - Rank by query relevance + popularity + recency
    // 4. Return top 20 with search scores
  }

  async searchByBarcode(barcode) {
    // 1. Check local foods
    // 2. Check apiCache
    // 3. Query OFF barcode endpoint
    // 4. Fallback to USDA search
  }
}
```

### 3.4 Caching & Offline Handling

```javascript
// src/integrations/cache.js
export class APICache {
  async get(apiName, query) {
    const hash = md5(apiName + query);
    const cached = await db.get('apiCache', hash);

    if (cached && new Date(cached.expiresAt) > new Date()) {
      cached.hitCount++;
      return cached.parsedResult;
    }

    if (!navigator.onLine) {
      return cached?.parsedResult || null;  // Stale fallback
    }

    return null;
  }

  async set(apiName, query, response, ttlDays = 7) {
    const hash = md5(apiName + query);
    const parsed = normalizeApiResponse(response);

    await db.put('apiCache', {
      id: hash,
      apiName,
      query,
      queryHash: hash,
      response,
      parsedResult: parsed,
      ttl: ttlDays * 24 * 60 * 60 * 1000,
      expiresAt: new Date(Date.now() + ttl),
      hitCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}
```

### 3.5 Network Error Recovery

```javascript
// src/integrations/openFoodFacts.js - retry logic
async function fetchWithRetry(url, maxRetries = 3) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) return response.json();

      // 4xx: Don't retry, return null
      if (response.status < 500) return null;

      // 5xx: Retry with exponential backoff
      if (response.status >= 500) throw new Error(`Server error: ${response.status}`);
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        await sleep(Math.pow(2, i) * 1000);  // 1s, 2s, 4s
      }
    }
  }

  console.error('API fetch failed:', lastError);
  return null;
}
```

---

## 4. AI INTEGRATION ARCHITECTURE (BYOK Pattern)

### 4.1 BYOK (Bring Your Own Key) Design

**Philosophy:** AI is completely optional. App must work 100% without it. Users provide their own API keys.

#### Security Model
- **Key Storage:** Encrypted in localStorage via `EncryptedStorage` utility
- **No Backend:** Keys never sent to server; requests executed client-side
- **Permissions:** User explicitly enables/disables per feature
- **Transparency:** All prompts shown to user; cost estimates provided

```javascript
// src/utils/storage.js
export class EncryptedStorage {
  static async setKey(name, value, masterPassword) {
    const encrypted = await encrypt(value, masterPassword);
    localStorage.setItem(`enc_${name}`, encrypted);
  }

  static async getKey(name, masterPassword) {
    const encrypted = localStorage.getItem(`enc_${name}`);
    if (!encrypted) return null;
    return await decrypt(encrypted, masterPassword);
  }
}

// Usage in settings
const apiKey = await EncryptedStorage.getKey('byok_openai_key', userPassword);
```

### 4.2 AI Provider Abstraction

Support for multiple LLM providers with unified interface.

```javascript
// src/integrations/aiClient.js
export class AIClient {
  constructor(provider, config) {
    // provider: "openai" | "anthropic" | "ollama"
    this.provider = provider;
    this.config = config;
  }

  async analyzeFood(imageBase64, opts = {}) {
    // Unified interface for all providers
    const prompt = buildFoodAnalysisPrompt(opts);
    return this.request('vision', { image: imageBase64, prompt });
  }

  async parseVoice(text, opts = {}) {
    const prompt = buildVoiceParsePrompt(text, opts);
    return this.request('text', { prompt });
  }

  async suggestMeals(userProfile, opts = {}) {
    const prompt = buildMealSuggestionPrompt(userProfile, opts);
    return this.request('text', { prompt });
  }

  async request(mode, input) {
    // Route to provider-specific implementation
    if (this.provider === 'openai') {
      return this._openaiRequest(mode, input);
    } else if (this.provider === 'anthropic') {
      return this._anthropicRequest(mode, input);
    } else if (this.provider === 'ollama') {
      return this._ollamaRequest(mode, input);
    }
  }
}
```

### 4.3 Food Analysis Prompts

#### Photo Analysis Prompt
```javascript
// src/integrations/imageProcessor.js
function buildFoodAnalysisPrompt(opts = {}) {
  const { includeQuantity = true, includePrepMethod = true } = opts;

  return `You are a nutrition expert analyzing a food photo.

Identify each visible food item and estimate:
${includeQuantity ? '- Quantity in standard units (grams, cups, pieces)' : ''}
${includePrepMethod ? '- Preparation method (fried, baked, raw, etc.)' : ''}
- Confidence level (0-1)
- Typical nutrition if portion is uncertain

Format your response as JSON:
{
  "foods": [
    {
      "name": "food name",
      "quantity": 100,
      "unit": "g",
      "prepMethod": "cooked",
      "confidence": 0.85,
      "alternatives": ["similar food if uncertain"]
    }
  ],
  "totalEstimatedCalories": 250,
  "notes": "Any relevant observations about portion estimation"
}

Be conservative with estimates. Ask clarifying questions if ambiguous.`;
}
```

#### Voice/Text Parsing Prompt
```javascript
function buildVoiceParsePrompt(text, opts = {}) {
  const { userGoals = {}, recentFoods = [] } = opts;

  return `Parse this meal description and extract food items:

Input: "${text}"

Recent foods user has logged: ${recentFoods.join(', ') || 'none'}
User's nutrition goals: ${JSON.stringify(userGoals)}

Extract foods with:
- Exact name
- Quantity if mentioned, else "estimated"
- Unit (g, cup, piece, tbsp)
- Preparation method if mentioned

Format as JSON:
{
  "foods": [
    { "name": "...", "quantity": 100, "unit": "g", "prepMethod": "..." }
  ],
  "confidence": 0.8,
  "clarifications": ["Did you mean...?"]
}

If unclear, ask for clarification rather than guessing.`;
}
```

#### Meal Suggestion Prompt
```javascript
function buildMealSuggestionPrompt(userProfile, opts = {}) {
  const { userHistory = [], remainingCalories, remainingMacros = {} } = opts;

  return `Suggest a meal based on user profile:

User Profile:
- Goal: ${userProfile.goals.calorieTarget} kcal/day
- Remaining today: ${remainingCalories} kcal
- Target macros: ${JSON.stringify(remainingMacros)}
- Recent history: ${userHistory.slice(-5).join(', ')}
- Preferences: ${userProfile.preferences?.join(', ') || 'none specified'}

Suggest 3 meal ideas that fit constraints. Each should include:
- Meal name
- Key ingredients
- Estimated nutrition
- Why it fits user's goals

Format as JSON:
{
  "suggestions": [
    {
      "name": "...",
      "description": "...",
      "estimatedNutrition": { "kcal": 400, "protein": 25 },
      "reasoning": "..."
    }
  ]
}`;
}
```

### 4.4 Response Parsing & Validation

```javascript
// src/integrations/imageProcessor.js
export async function parseAndValidateFoodAnalysis(aiResponse, opts = {}) {
  try {
    // 1. Parse JSON from response
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');

    const parsed = JSON.parse(jsonMatch[0]);

    // 2. Validate structure
    if (!Array.isArray(parsed.foods)) throw new Error('Invalid foods array');

    // 3. Normalize each food
    const validated = {
      foods: parsed.foods.map(food => ({
        name: String(food.name).trim(),
        quantity: Math.max(1, Number(food.quantity) || 100),
        unit: food.unit || 'g',
        prepMethod: food.prepMethod || '',
        confidence: Math.min(1, Math.max(0, Number(food.confidence) || 0.5)),
        alternatives: Array.isArray(food.alternatives) ? food.alternatives : []
      })),
      totalEstimatedCalories: Number(parsed.totalEstimatedCalories) || null,
      notes: String(parsed.notes || '')
    };

    // 4. Flag low-confidence items
    validated.flagged = validated.foods.filter(f => f.confidence < 0.6);

    // 5. Store for user review
    if (opts.storeForReview) {
      await db.put('aiConversations', {
        id: uuidv4(),
        type: 'photo-analysis',
        userInput: { imageBase64: opts.imageBase64 },
        aiResponse: { foods: validated.foods, alternatives: validated.alternatives },
        status: 'success',
        createdAt: new Date().toISOString()
      });
    }

    return validated;
  } catch (error) {
    console.error('Food analysis parsing failed:', error);
    return { foods: [], flagged: [], error: error.message };
  }
}
```

### 4.5 Cost Tracking & Limits

```javascript
// src/integrations/aiClient.js
export class AIClient {
  static COST_ESTIMATES = {
    openai: {
      'gpt-4-vision': { inputToken: 0.01 / 1000, outputToken: 0.03 / 1000 },
      'gpt-4-turbo': { inputToken: 0.01 / 1000, outputToken: 0.03 / 1000 }
    },
    anthropic: {
      'claude-opus': { inputToken: 0.015 / 1000, outputToken: 0.075 / 1000 }
    }
  };

  async trackRequest(provider, model, inputTokens, outputTokens) {
    const costs = this.COST_ESTIMATES[provider]?.[model];
    if (!costs) return null;

    const estimatedCost = (inputTokens * costs.inputToken) +
                          (outputTokens * costs.outputToken);

    // Warn if cost exceeds threshold
    if (estimatedCost > 0.10) {
      console.warn(`High cost estimate: $${estimatedCost.toFixed(2)}`);
    }

    return estimatedCost;
  }
}
```

### 4.6 Feature Flags for AI Components

```javascript
// src/pages/settings.js - AI feature toggles
const aiFeatures = {
  photoAnalysis: {
    name: 'Photo-based food identification',
    enabled: userSettings.byokEnabled && userSettings.byokProvider !== null,
    requires: ['camera', 'byok'],
    costPerUse: 0.005
  },
  voiceParsing: {
    name: 'Voice meal logging',
    enabled: userSettings.byokEnabled && userSettings.byokProvider !== null,
    requires: ['microphone', 'byok'],
    costPerUse: 0.001
  },
  mealSuggestions: {
    name: 'AI meal suggestions',
    enabled: userSettings.byokEnabled && userSettings.byokProvider !== null,
    requires: ['byok'],
    costPerUse: 0.002
  }
};

// User can toggle each feature independently
```

---

## 5. OFFLINE-FIRST STRATEGY

### 5.1 Service Worker & Caching Layers

```javascript
// vite.config.js - PWA plugin configuration
import { VitePWA } from 'vite-plugin-pwa';

export default {
  plugins: [
    VitePWA({
      registerType: 'prompt',  // Let user choose update timing
      strategies: 'injectManifest',  // Custom SW logic
      workbox: {
        globPatterns: ['**/*.{js,css,html}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/world\.openfoodfacts\.org/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'off-api-cache',
              expiration: { maxAgeSeconds: 7 * 24 * 60 * 60 }  // 7 days
            }
          },
          {
            urlPattern: /^https:\/\/fdc\.nal\.usda\.gov/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'usda-fdc-cache',
              expiration: { maxAgeSeconds: 30 * 24 * 60 * 60 }  // 30 days
            }
          },
          {
            urlPattern: /^https:\/\/api\.openai\.com/,
            handler: 'NetworkOnly'  // No caching for LLM calls
          }
        ]
      }
    })
  ]
};
```

### 5.2 IndexedDB as Primary Store

All user data lives in IndexedDB; it's the source of truth locally.

```javascript
// src/data/db.js - IndexedDB wrapper
export class LibreLogDB {
  async init() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('librelog', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Create all object stores
        ['users', 'foods', 'meals', 'recipes', 'measurements',
         'aiConversations', 'syncLog', 'apiCache'].forEach(store => {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'id' });
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // CRUD operations...
}
```

### 5.3 Sync Queue & Conflict Resolution

When network returns, apply delta sync.

```javascript
// src/data/sync.js
export class SyncEngine {
  async syncWithRemote(remoteUrl) {
    // 1. Get all pending operations from syncLog
    const pending = await db.getAllWhere('syncLog', 'status', 'pending');

    // 2. For each pending operation, attempt remote update
    for (const op of pending) {
      try {
        const entity = await db.get(op.entityType, op.entityId);
        if (!entity) continue;  // Local delete

        const remoteData = await fetchFromRemote(remoteUrl, op.entityType, op.entityId);

        if (remoteData && remoteData.updatedAt > entity.updatedAt) {
          // Remote is newer: conflict
          await handleConflict(entity, remoteData, op);
        } else {
          // Local is newer or remote doesn't exist: push update
          await pushToRemote(remoteUrl, op.entityType, entity);
          op.status = 'synced';
          op.lastSyncAt = new Date().toISOString();
          await db.put('syncLog', op);
        }
      } catch (error) {
        console.error('Sync failed for', op.entityId, error);
        op.status = 'error';
        op.updatedAt = new Date().toISOString();
        await db.put('syncLog', op);
      }
    }
  }

  async handleConflict(local, remote, syncOp) {
    // Strategy: local-wins (user's device takes precedence)
    // Could also implement: 3-way merge, remote-wins, manual resolution

    syncOp.conflict = {
      resolved: true,
      strategy: 'local',
      mergeDetails: { local, remote }
    };
    await db.put('syncLog', syncOp);
  }
}
```

### 5.4 Meal Entry Offline Flow

```javascript
// src/pages/diary.js
async function logMeal(mealData) {
  // 1. Create meal in IndexedDB immediately
  const meal = {
    id: uuidv4(),
    ...mealData,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await db.put('meals', meal);

  // 2. Create sync record
  await db.put('syncLog', {
    id: uuidv4(),
    entityType: 'meals',
    entityId: meal.id,
    operation: 'create',
    localVersion: 1,
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  // 3. Update UI immediately (optimistic)
  updateDiaryUI();

  // 4. When online, sync automatically
  if (navigator.onLine) {
    scheduleSync();  // Batched sync, not immediate
  }
}
```

### 5.5 Periodic Background Sync

```javascript
// src/app.js - ServiceWorker registration with background sync
if ('serviceWorker' in navigator && 'SyncManager' in window) {
  navigator.serviceWorker.ready.then(reg => {
    // Register periodic sync every 6 hours (if online)
    reg.periodicSync.register('sync-meals', { minInterval: 6 * 60 * 60 * 1000 });
  });
}

// In service worker
self.addEventListener('sync', event => {
  if (event.tag === 'sync-meals') {
    event.waitUntil(syncMealsWithRemote());
  }
});
```

---

## 6. DATA SAFETY & BACKUP

### 6.1 IndexedDB Reliability Problem

**Issue:** Browser can clear IndexedDB without warning (especially on Android <11).

**Solutions:**

#### 6.1.1 Auto-Backup Strategy

```javascript
// src/data/backup.js
export class BackupManager {
  async autoBackup(interval = 6 * 60 * 60 * 1000) {
    // Run every 6 hours
    setInterval(async () => {
      if (navigator.onLine) {
        await this.backup();
      }
    }, interval);
  }

  async backup() {
    try {
      // 1. Export all data to JSON
      const backupData = await this.exportAllData();

      // 2. Upload to WebDAV (if enabled)
      if (userSettings.webdavEnabled) {
        await uploadToWebDAV(backupData);
      }

      // 3. Upload to GitHub Gist (if enabled)
      if (userSettings.gistBackupEnabled) {
        await uploadToGist(backupData);
      }

      // 4. Store last backup timestamp
      await db.put('_config', { id: 'lastBackup', value: new Date().toISOString() });

    } catch (error) {
      console.error('Auto-backup failed:', error);
      notifyUser('Backup failed', 'error');
    }
  }

  async exportAllData() {
    return {
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      users: await db.getAll('users'),
      foods: await db.getAll('foods'),
      meals: await db.getAll('meals'),
      recipes: await db.getAll('recipes'),
      measurements: await db.getAll('measurements')
    };
  }
}
```

#### 6.1.2 Persistent Storage API (for Android)

```javascript
// src/utils/storage.js
export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    const persistent = await navigator.storage.persist();
    if (persistent) {
      console.log('IndexedDB persistent storage granted');
      return true;
    }
  }
  return false;
}

// Request on first load
if (navigator.storage && navigator.storage.request) {
  try {
    await navigator.storage.request();
  } catch (error) {
    console.warn('Persistent storage denied:', error);
  }
}
```

### 6.2 Export Formats

#### JSON (Full Compatibility)
```javascript
// Complete backup format, restorable to any device
{
  version: 1,
  exportedAt: "2026-04-06T10:30:00Z",
  appVersion: "1.0.0",
  users: [...],
  foods: [...],
  meals: [...],
  recipes: [...],
  measurements: [...]
}
```

#### CSV (Portable, Data Analyst-Friendly)
```
date,mealType,foodName,quantity,unit,kcal,protein,carbs,fat
2026-04-06,breakfast,Eggs,2,piece,155,13,1,11
2026-04-06,breakfast,Toast,1,slice,80,2.7,14,1
```

#### Encrypted JSON (Zero-Knowledge Backup)
```javascript
// For cloud storage without exposing server to data
export async function exportEncrypted(password) {
  const backupData = await backupManager.exportAllData();
  const encrypted = await encryptAES256(JSON.stringify(backupData), password);
  return btoa(encrypted);  // Base64
}

export async function importEncrypted(encryptedData, password) {
  const decrypted = await decryptAES256(atob(encryptedData), password);
  return JSON.parse(decrypted);
}
```

### 6.3 Restoration Process

```javascript
// src/pages/settings.js
async function restoreFromBackup(backupFile) {
  try {
    // 1. Parse backup
    const backup = JSON.parse(backupFile);
    if (backup.version !== SCHEMA_VERSION) {
      throw new Error(`Incompatible backup version: ${backup.version}`);
    }

    // 2. Confirm with user (destructive operation)
    const confirmed = await showConfirmDialog(
      'This will replace all local data. Continue?'
    );
    if (!confirmed) return;

    // 3. Backup current state first
    await backupManager.backup();

    // 4. Clear and restore
    await db.clear('meals');
    await db.clear('foods');
    await db.clear('recipes');
    await db.clear('measurements');

    // 5. Restore data
    for (const meal of backup.meals) {
      await db.put('meals', meal);
    }
    // ... repeat for other tables

    // 6. Sync on next online event
    scheduleSync();

    notifyUser('Restore complete', 'success');
  } catch (error) {
    notifyUser(`Restore failed: ${error.message}`, 'error');
  }
}
```

### 6.4 WebDAV Sync

```javascript
// src/integrations/webdav.js
export class WebDAVSync {
  constructor(url, username, password) {
    this.url = url;
    this.auth = btoa(`${username}:${password}`);
  }

  async upload(backupData) {
    const filename = `librelog-backup-${new Date().toISOString().split('T')[0]}.json`;
    const path = `${this.url}/backups/${filename}`;

    const response = await fetch(path, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(backupData)
    });

    if (!response.ok) throw new Error(`WebDAV upload failed: ${response.status}`);
    return filename;
  }

  async list() {
    const response = await fetch(`${this.url}/backups/`, {
      method: 'PROPFIND',
      headers: { 'Authorization': `Basic ${this.auth}` }
    });
    // Parse WebDAV XML response
  }

  async download(filename) {
    const response = await fetch(`${this.url}/backups/${filename}`, {
      headers: { 'Authorization': `Basic ${this.auth}` }
    });
    return response.json();
  }
}
```

### 6.5 GitHub Gist Backup (Optional)

```javascript
// src/integrations/gistBackup.js
export class GistBackup {
  async upload(backupData) {
    const response = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': `token ${githubToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: `LibreLog backup - ${new Date().toISOString().split('T')[0]}`,
        public: false,
        files: {
          'librelog-backup.json': {
            content: JSON.stringify(backupData)
          }
        }
      })
    });

    if (!response.ok) throw new Error(`Gist upload failed`);
    const gist = await response.json();
    return gist.id;
  }
}
```

---

## 7. PERFORMANCE CONSIDERATIONS

### 7.1 Food Search Performance

**Problem:** 100K+ foods in local + API searches.

**Solutions:**

#### 7.1.1 Indexed Search
```javascript
// Fast fuzzy matching with weighted scoring
class FuzzySearcher {
  search(query, foods, opts = {}) {
    const q = query.toLowerCase();

    return foods
      .map(food => {
        let score = 0;

        // Exact name match: highest weight
        if (food.name.toLowerCase() === q) score += 100;
        // Prefix match: high weight
        else if (food.name.toLowerCase().startsWith(q)) score += 50;
        // Contains: medium weight
        else if (food.name.toLowerCase().includes(q)) score += 25;
        // Fuzzy match (Levenshtein): low weight
        else score = 10 - levenshteinDistance(q, food.name.toLowerCase());

        // Popularity boost
        score += (food.popularity || 0) * 0.1;

        // Recency boost (recently used)
        if (opts.recentFoods?.includes(food.id)) score += 20;

        return { food, score };
      })
      .filter(r => r.score > 5)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit || 20)
      .map(r => r.food);
  }
}
```

#### 7.1.2 Autocomplete with Debounce
```javascript
// src/components/foodSearch.js
let searchTimeout;
const searchInput = document.querySelector('#food-search');

searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);

  const query = e.target.value;
  if (query.length < 2) {
    clearAutocomplete();
    return;
  }

  searchTimeout = setTimeout(async () => {
    // Concurrent local + API search
    const [localResults, apiResults] = await Promise.all([
      searchLocal(query),
      searchAPIsIfNoLocal(query, localResults)
    ]);

    renderAutocomplete(localResults.slice(0, 10));
  }, 300);
});
```

#### 7.1.3 Pagination & Lazy Loading
```javascript
// Large meal diary: paginate by week
class DiaryPagination {
  constructor(pageSize = 7) {
    this.pageSize = pageSize;
    this.currentPage = 0;
  }

  async loadPage(pageNum) {
    const startDate = subDays(today, pageNum * this.pageSize);
    const endDate = addDays(startDate, this.pageSize);

    return db.getAllWhere(
      'meals',
      'date',
      IDBKeyRange.bound(
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0]
      )
    );
  }
}
```

### 7.2 Large Dataset Handling

**Problem:** Years of meal data = slow DOM rendering.

**Solutions:**

#### 7.2.1 Virtual Scrolling
```javascript
// src/components/mealList.js - Virtual scroll for 1000+ meals
class VirtualMealList {
  constructor(container, meals, itemHeight = 100) {
    this.container = container;
    this.meals = meals;
    this.itemHeight = itemHeight;
    this.visibleRange = { start: 0, end: 0 };
  }

  render() {
    const scrollTop = this.container.scrollTop;
    const visibleCount = Math.ceil(this.container.clientHeight / this.itemHeight);

    this.visibleRange.start = Math.floor(scrollTop / this.itemHeight);
    this.visibleRange.end = this.visibleRange.start + visibleCount + 1;

    // Only render visible items + buffer
    const visibleMeals = this.meals.slice(
      this.visibleRange.start,
      this.visibleRange.end
    );

    this.container.innerHTML = '';
    visibleMeals.forEach((meal, idx) => {
      const element = createMealElement(meal);
      element.style.transform = `translateY(${(this.visibleRange.start + idx) * this.itemHeight}px)`;
      this.container.appendChild(element);
    });
  }

  onScroll = () => {
    this.render();
  };
}

document.addEventListener('scroll', list.onScroll);
```

#### 7.2.2 Aggregated History Views
```javascript
// Instead of rendering all 365 days, show aggregated weekly/monthly
class NutritionHistory {
  async getTrendData(days = 90) {
    const meals = await db.getAllWhere(
      'meals',
      'date',
      IDBKeyRange.bound(
        subDays(today, days).toISOString().split('T')[0],
        today.toISOString().split('T')[0]
      )
    );

    // Group by week, average nutrition
    const weekly = {};
    meals.forEach(meal => {
      const week = getWeekNumber(new Date(meal.date));
      weekly[week] = weekly[week] || { kcal: 0, count: 0 };
      weekly[week].kcal += meal.totals.kcal;
      weekly[week].count += 1;
    });

    // Return aggregated data for charting
    return Object.entries(weekly).map(([week, data]) => ({
      week,
      avgKcal: data.kcal / data.count
    }));
  }
}
```

### 7.3 Image Handling

**Problem:** Food photos can be large; users upload multiple per meal.

**Solutions:**

#### 7.3.1 Image Compression
```javascript
// src/utils/imageProcessor.js
export async function compressImage(file, opts = {}) {
  const { maxWidth = 800, maxHeight = 800, quality = 0.7 } = opts;

  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement('canvas');
        const { width, height } = fitDimensions(
          img.width,
          img.height,
          maxWidth,
          maxHeight
        );

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => resolve(blob),
          'image/jpeg',
          quality
        );
      };

      img.src = e.target.result;
    };

    reader.readAsDataURL(file);
  });
}
```

#### 7.3.2 Thumbnail Storage
```javascript
// Store small thumbnail, keep full resolution only for AI analysis
const compressedImage = await compressImage(userImage, {
  maxWidth: 400,
  maxHeight: 400,
  quality: 0.5
});

const thumbnailBase64 = await blobToBase64(compressedImage);
await db.put('meals', {
  ...mealData,
  metadata: { photoThumbnail: thumbnailBase64 }
});

// Only pass full-res to AI if requested
const fullImage = await compressImage(userImage, {
  maxWidth: 1200,
  maxHeight: 1200,
  quality: 0.9
});
```

#### 7.3.3 Lazy Load Image Thumbnails
```javascript
// Defer loading meal photos until visible
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const mealCard = entry.target;
      const image = mealCard.querySelector('img[data-src]');
      if (image) {
        image.src = image.dataset.src;
        image.removeAttribute('data-src');
        observer.unobserve(mealCard);
      }
    }
  });
}, { rootMargin: '50px' });

document.querySelectorAll('.meal-card').forEach(card => {
  observer.observe(card);
});
```

### 7.4 State Management & Caching

```javascript
// src/data/state.js - In-memory cache of hot data
export class StateManager {
  constructor() {
    this.cache = {
      today: null,
      recentFoods: [],
      userProfile: null,
      goals: null
    };
    this.cacheTimestamp = {};
  }

  async getTodayMeals() {
    const now = Date.now();

    // Invalidate cache every 5 minutes
    if (this.cache.today && (now - this.cacheTimestamp.today) < 5 * 60 * 1000) {
      return this.cache.today;
    }

    const today = new Date().toISOString().split('T')[0];
    this.cache.today = await db.getAllWhere('meals', 'date', today);
    this.cacheTimestamp.today = now;

    return this.cache.today;
  }

  invalidateCache(key) {
    this.cache[key] = null;
    delete this.cacheTimestamp[key];
  }
}
```

---

## 8. INCREMENTAL BUILD PLAN

### Phase 1: MVP (Weeks 1-4)

**Goal:** Functional meal diary with manual entry.

#### Milestones
1. **Core Infrastructure** (Week 1)
   - Vite + Capacitor setup
   - IndexedDB schema + db.js wrapper
   - Hash-based routing (app.js)
   - PWA manifest + service worker

2. **Daily Diary UI** (Week 2)
   - Diary page with date navigation
   - Meal type tabs (breakfast, lunch, dinner, snacks)
   - Add meal modal
   - Display macro/calorie totals

3. **Food Database** (Week 2-3)
   - Seed common foods (100-500 items)
   - Manual food add form
   - Search local foods by name
   - Serving size adjustments

4. **Nutrition Calculations** (Week 3)
   - Macro/calorie calculations
   - Daily summary card
   - Progress toward goals

5. **Mobile Polish** (Week 4)
   - Responsive UI (mobile-first)
   - Haptics feedback on interactions
   - Offline functionality confirmed
   - Deploy PWA to web + test on Android/iOS

#### Deliverables
- Standalone MVP web + mobile apps
- ~50 Meals logged to 100 users
- Data persists offline
- Manual entry workflow smooth

---

### Phase 2: Enhanced Core (Weeks 5-8)

**Goal:** API integration, better search, recipe system.

#### Milestones
1. **Open Food Facts Integration** (Week 5)
   - Text search via OFF API
   - Barcode scanning (Capacitor camera plugin)
   - API response caching (7 days)
   - Offline fallback to cached results

2. **Advanced Search** (Week 5-6)
   - Fuzzy matching in local foods
   - Recent foods quick-add
   - Custom food creation
   - Food import from OFF photos

3. **Recipe System** (Week 6-7)
   - Recipe builder (multi-item meals)
   - Recipe templates & quick-save
   - Recipe sharing (private URLs)
   - Scale recipe by servings

4. **Weight & Progress Tracking** (Week 7)
   - Weight logger (daily weigh-ins)
   - Weight trend chart (canvas-based)
   - Body measurements (optional: neck, waist, etc.)
   - Progress photo timeline

5. **Settings & Personalization** (Week 8)
   - Goal configuration (calorie target, macros)
   - Theme toggle (light/dark)
   - Data export (JSON + CSV)
   - Account/profile setup

#### Deliverables
- 1000+ foods (seed + OFF API)
- Barcode scanning working
- Recipe creation & reuse
- Weight tracking with trends
- Export data for backup

---

### Phase 3: AI Integration (Weeks 9-12)

**Goal:** Optional AI features (BYOK pattern).

#### Milestones
1. **BYOK Infrastructure** (Week 9)
   - Settings page: AI provider selection
   - Secure key storage (encrypted localStorage)
   - Cost estimation & tracking
   - Feature flags per provider

2. **Photo Analysis** (Week 9-10)
   - Camera capture + upload
   - Call OpenAI Vision API with custom prompt
   - Parse JSON response (food + quantity)
   - User confirmation modal for flagged items
   - Store in aiConversations table

3. **Voice Parsing** (Week 10-11)
   - Voice input via Capacitor microphone
   - STT (OpenAI Whisper or Google Cloud)
   - Parse transcription ("I had 2 eggs + toast") → foods
   - Quick meal creation from voice

4. **Meal Suggestions** (Week 11-12)
   - Contextual LLM prompts (user history + goals + remaining macros)
   - 3 meal suggestions with reasoning
   - 1-tap logging of suggested meal
   - Opt-out per meal type

5. **Prompt Engineering & Safety** (Week 12)
   - Comprehensive prompt library
   - Validation of LLM outputs (schema + sanity checks)
   - Error handling for LLM failures
   - Privacy documentation for users

#### Deliverables
- Photo-based food logging (optional)
- Voice meal logging (optional)
- AI meal suggestions (optional)
- Cost tracking per session
- All 100% opt-in

---

### Phase 4: Community & Polish (Weeks 13-16)

**Goal:** Community features, advanced analytics, production hardening.

#### Milestones
1. **Nutrition Analytics** (Week 13)
   - Weekly/monthly macro breakdowns
   - Nutrient adequacy tracking (fiber, vitamins, minerals)
   - Custom nutrient targets
   - Trend analysis (30/60/90 day averages)

2. **WebDAV Sync & Backup** (Week 13-14)
   - WebDAV client for file sync
   - Auto-backup on schedule (every 6 hours)
   - GitHub Gist backup option
   - Restore from backup with conflict resolution

3. **Community Features** (Week 14-15)
   - Shared recipe library (read-only browse)
   - Anonymous aggregate stats (opt-in)
   - Recipe ratings & comments (future phase)
   - Integration with LibreLift workout data

4. **Security & Compliance** (Week 15)
   - Security audit (IndexedDB, localStorage, API calls)
   - Privacy policy finalization
   - Data deletion on uninstall
   - GDPR compliance review

5. **Performance Optimization** (Week 15-16)
   - Virtual scrolling for 1000+ meal history
   - Image compression & lazy loading
   - API cache eviction strategy
   - Bundle size optimization

6. **Deployment & Release** (Week 16)
   - Production PWA deployment
   - iOS App Store submission (via Capacitor)
   - Google Play Store submission
   - Release notes & marketing assets

#### Deliverables
- v1.0 production release
- iOS + Android apps
- Data backup strategy tested
- 1000+ community users
- Analytics dashboard (internal)

---

### Release Timeline

| Phase | Duration | Builds | Key Features |
|-------|----------|--------|--------------|
| **MVP** | Weeks 1-4 | Web PWA | Manual diary, local foods, basic nutrition |
| **Enhanced** | Weeks 5-8 | Web + Mobile | API search, recipes, weight tracking |
| **AI** | Weeks 9-12 | Web + Mobile | Photo/voice logging, suggestions (optional) |
| **Community** | Weeks 13-16 | Web + iOS + Android | Analytics, sync, shared library |

---

## 9. KEY DESIGN DECISIONS

### 9.1 Why Vanilla JS + Vite (not React/Vue)

- **Consistency:** Aligns with LibreLift's proven stack
- **Performance:** No framework overhead; minimal bundle size (<100KB)
- **Offline:** Direct IndexedDB control; no abstraction layers
- **Maintenance:** FLOSS community can fork/modify easily
- **Dependencies:** Fewer transitive deps = better security

### 9.2 Why IndexedDB (not SQLite/WasmSQL)

- **Offline-first:** Built-in service worker sync patterns
- **Browser API:** No plugins needed; works in PWA
- **Capacitor:** Seamless on iOS/Android
- **Limitation awareness:** Backup strategy mitigates reliability risk

### 9.3 Why Open Food Facts + USDA (not single API)

- **Redundancy:** One API down? Fall back to other
- **Coverage:** OFF strong in Europe; USDA strong in US
- **Open Data:** Both FLOSS-friendly; no vendor lock-in
- **Cost:** Free tier sufficient for MVP → Enhanced

### 9.4 Why BYOK AI (not Backend Service)

- **Privacy:** No server sees user's food data or API keys
- **Cost:** User pays for their own LLM usage
- **Flexibility:** User chooses provider (OpenAI, Anthropic, Ollama, etc.)
- **Offline:** App works 100% without internet
- **Compliance:** No data processing agreements needed

### 9.5 Why Soft-Delete (not Hard-Delete)

- **Data recovery:** Accidental deletes reversible
- **Analytics:** Historical data never lost
- **Sync:** Soft-delete can be resolved in conflict scenarios
- **Privacy:** Users can request hard-delete in settings (GDPR)

---

## 10. SECURITY & PRIVACY CONSIDERATIONS

### 10.1 Storage Security

- **Encryption at Rest:** BYOK keys encrypted via master password
- **No Cleartext API Keys:** Keys never in localStorage (unless encrypted)
- **HTTPS Only:** All API calls over HTTPS; validate certificates
- **CSP Headers:** Prevent XSS via Content Security Policy

### 10.2 Data Privacy

- **User Data:** Stored locally; never sent to Libre servers
- **Optional Analytics:** Aggregate stats only with explicit opt-in
- **Aggregation:** Personal data anonymized before any sharing
- **Deletion:** User can delete all data via settings; soft-deletes honored in 30 days

### 10.3 API Security

- **Rate Limiting:** Implement client-side rate limits (OFF: 1 req/sec, USDA: 2 req/sec)
- **User Agent:** Identify as LibreLog in API headers
- **Error Handling:** Never expose API keys in error messages

### 10.4 AI Safety (BYOK)

- **User Controls:** Enable/disable per feature
- **Transparency:** Show prompts + costs before request
- **Validation:** Sanity-check LLM responses (e.g., 0-3000 kcal ranges)
- **Logging:** Store conversation history for review
- **Cost Limits:** Warn if cost exceeds threshold

---

## 11. TESTING STRATEGY

### 11.1 Unit Tests
- Data layer: db.js CRUD operations
- Engine: Nutrition calculations, validation
- Utils: Format, sanitize, validation helpers
- Integrations: API response parsing

### 11.2 Integration Tests
- Diary workflow: Create meal → Update → Delete
- Food search: Local → Cache → API fallback
- Sync: Pending → Synced → Conflict resolution
- Backup: Export → Import with data integrity

### 11.3 E2E Tests
- User journey: Signup → Logging meals → Tracking progress → Export data
- Offline scenario: Log meal offline → Sync when online
- AI workflow: Upload photo → Confirm foods → Log meal

### 11.4 Performance Tests
- Large diary (1000+ meals): Load time <2s
- Search (10K foods): Autocomplete <300ms
- Image compression: <500KB per photo
- Service worker: Offline mode works smoothly

---

## 12. DEPLOYMENT & MONITORING

### 12.1 Build Process

```bash
# Development
npm run dev              # Vite dev server on :5173

# Production
npm run build            # Vite build → dist/
npm run preview          # Preview production build

# Mobile
npm run build
npx cap add ios
npx cap add android
npx cap build ios
npx cap build android
```

### 12.2 PWA Deployment

- **Web:** Deploy `dist/` to any static host (Vercel, Netlify, GitHub Pages)
- **Manifest:** Serve from `dist/manifest.webmanifest`
- **HTTPS:** Required for PWA; use Let's Encrypt
- **Caching:** Service worker caches app shell + API responses

### 12.3 Native App Distribution

- **iOS:** TestFlight → App Store (paid or free)
- **Android:** Internal testing → Google Play Store
- **Certificates:** iOS provisioning profiles; Android signing keys stored securely

### 12.4 Monitoring

- **Error Logging:** Capture JS errors (Sentry or Rollbar)
- **Analytics:** Anonymous session metrics (if opt-in)
- **Backup Success:** Track auto-backup completion rate
- **API Health:** Monitor OFF + USDA response times

---

## CONCLUSION

LibreLog is architected for privacy-first meal tracking with optional AI capabilities. The design:

1. **Aligns completely with LibreLift** (Vanilla JS, Vite, IndexedDB, Capacitor, AGPL-3.0)
2. **Solves the Waistline data reliability problem** via auto-backup to WebDAV/Gist
3. **Enables offline-first workflows** with service workers + delta sync
4. **Integrates free APIs** (Open Food Facts, USDA FDC) with intelligent caching
5. **Adds optional AI** (BYOK) without requiring a backend or compromising privacy
6. **Scales from MVP** (manual diary) → **Enhanced** (APIs + recipes) → **AI** (photos/voice) → **Community** (analytics + sharing)

The incremental build plan delivers value quickly while maintaining code quality and FLOSS principles.
