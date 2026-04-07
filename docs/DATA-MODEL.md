# LibreLog Data Model Reference

**Status:** Technical Reference
**Updated:** April 2026

Complete data schema documentation with normalization rules, validation constraints, and examples.

---

## 1. Core Tables

### 1.1 `users` (Singleton)

Single record per device/account. Fixed ID: `"user-1"`.

**Schema:**

```javascript
{
  id: "user-1",                          // Fixed singleton key
  profile: {
    name: String,                        // Display name
    age: Number,                         // Years (0-150)
    gender: "M" | "F" | "Other",
    heightCm: Number,                    // For BMI calculations
    startDate: ISO8601,                  // When user started tracking
    timezone: String,                    // e.g., "America/New_York"
    language: "en" | "es" | "fr"         // Default: "en"
  },
  goals: {
    calorieTarget: Number,               // kcal/day (1200-10000)
    macroTargets: {
      proteinG: Number,                  // Grams/day (50-300)
      carbG: Number,                     // Grams/day (50-400)
      fatG: Number                       // Grams/day (20-200)
    },
    microTargets: {
      fiberG: Number,                    // Grams/day (20-50)
      sodiumMg: Number,                  // mg/day (1000-3000)
      waterL: Number,                    // Liters/day (1.5-3.5)
      calciumMg: Number | null,
      ironMg: Number | null
    },
    trackingMode: "calories" | "macros" | "detailed",
    activityLevel: "sedentary" | "light" | "moderate" | "active" | "veryActive"
  },
  integrations: {
    openFoodFactsEnabled: Boolean,       // Default: true
    usdaFdcEnabled: Boolean,             // Default: true
    byokEnabled: Boolean,                // Default: false
    byokProvider: "openai" | "anthropic" | "ollama" | null,
    byokModel: String,                   // e.g., "gpt-4-vision-preview"
    webdavEnabled: Boolean,              // Default: false
    webdavUrl: String,                   // Encrypted
    webdavUsername: String               // Encrypted
  },
  aiSettings: {
    photoParsing: Boolean,               // Photo analysis enabled
    voiceParsing: Boolean,               // Voice transcription enabled
    autoSuggest: Boolean,                // Meal suggestions
    voiceProvider: "openai" | "google" | null
  },
  privacy: {
    shareAggregateStats: Boolean,        // Anonymized metrics to Libre
    allowAnalytics: Boolean,             // Session telemetry
    deleteDataOnUninstall: Boolean       // Auto-delete on app removal
  },
  theme: "light" | "dark" | "auto",
  appVersion: String,                    // Version on last update
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

**Validation:**
- `age`: 0-150, integer
- `heightCm`: 100-250, number
- `calorieTarget`: 1200-10000, integer
- `trackingMode`: One of allowed values
- `timezone`: Valid IANA timezone string

**Indexes:** None (singleton)

---

### 1.2 `foods` (Catalog)

Foods can be:
- User-created custom entries
- API-sourced (Open Food Facts, USDA)
- Recipe-based (saved as reusable food)

**Schema:**

```javascript
{
  id: UUID,                              // e.g., "550e8400-e29b-41d4-a716-446655440000"
  name: String,                          // e.g., "Chicken Breast (skinless, roasted)"
  description: String,                   // User notes or OFF description
  servingSize: {
    quantity: Number,                    // e.g., 100
    unit: String                         // "g", "oz", "cup", "tbsp", "ml", "piece"
  },
  servingAliases: [
    {
      quantity: Number,                  // e.g., 1
      unit: String,                      // e.g., "piece"
      quantityInBaseUnit: Number         // e.g., 180 (grams)
    }
  ],
  nutrients: {
    energy: {
      kcal: Number,                      // Per serving
      kJ: Number
    },
    macros: {
      protein: {
        g: Number,
        percent: Number                  // % of calories
      },
      carbs: {
        g: Number,
        percent: Number
      },
      fat: {
        g: Number,
        percent: Number
      }
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
      vitaminA: { mcg: Number },         // Retinol activity equivalents
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
    offId: String | null,                // Open Food Facts product code (EAN-13)
    usdaId: String | null,               // USDA FDC ID
    recipeId: UUID | null                // If type="recipe", ref to recipes table
  },
  barcode: {
    ean13: String | null,                // e.g., "5901234123457"
    upc: String | null,
    alternates: [String]                 // Other barcodes for same product
  },
  category: String,                      // e.g., "Poultry", "Dairy", "Vegetables"
  tags: [String],                        // e.g., ["organic", "high-protein", "keto-friendly"]
  density: Number | null,                // g/ml (for liquids; density = 1.0 for water)
  photos: {
    thumbnail: String,                   // Base64 or CDN URL (<100KB)
    full: String                         // URL or base64 (<500KB)
  },
  offMetadata: {
    country: String,                     // e.g., "United States"
    brand: String,
    ingredients: [String],               // Ingredient list from OFF
    allergens: [String],                 // e.g., ["milk", "peanuts"]
    certifications: [String]             // e.g., ["organic", "fair-trade"]
  },
  popularity: Number,                    // 0-100, user search frequency
  searchBoost: Number,                   // 1.0 = default, >1.0 = boost ranking
  userCreated: Boolean,                  // True if user-defined, false if API
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

**Validation:**
- `name`: Required, 1-200 characters, not empty
- `servingSize.quantity`: >0
- `servingSize.unit`: Must be valid unit (see below)
- `nutrients.energy.kcal`: 0-10000
- `density`: If present, >0

**Valid Units:**
```javascript
const VALID_UNITS = [
  'g',      // grams
  'oz',     // ounces
  'cup',    // US cup
  'tbsp',   // tablespoon
  'tsp',    // teaspoon
  'ml',     // milliliters
  'l',      // liters
  'piece',  // whole item
  'slice',  // slice
  'inch'    // linear measurement
];
```

**Indexes:**
- `name` (for autocomplete search)
- `barcode.ean13` (for barcode lookup)
- `source.type` (to filter custom vs API)

---

### 1.3 `meals` (Daily Diary)

Individual meal entry in the diary. Multiple meals per day.

**Schema:**

```javascript
{
  id: UUID,
  userId: UUID,                          // Currently unused (future multi-device)
  date: "2026-04-06",                    // YYYY-MM-DD (for fast queries)
  mealType: "breakfast" | "lunch" | "dinner" | "snack" | "other",
  name: String,                          // User-facing: "Grilled Chicken with Rice"
  time: "09:30" | null,                  // HH:MM (optional)
  items: [
    {
      id: UUID,                          // Unique ID for ordering/updates
      foodId: UUID,                      // Reference to foods table
      quantity: Number,                  // 150
      unit: String,                      // "g"
      notes: String,                     // "fried in 2 tbsp olive oil"
      aiFlagReason: String | null        // "portion estimated from photo"
    }
  ],
  totals: {                              // Cached, recalculated on edit
    kcal: Number,
    macros: {
      proteinG: Number,
      carbG: Number,
      fatG: Number
    },
    fiber: Number,
    sodium: Number,
    calcium: Number,
    iron: Number
  },
  source: {
    type: "manual" | "recipe" | "ai" | "voice" | "barcode",
    recipeId: UUID | null,               // If created from recipe
    aiImagePath: String | null,          // Stored image hash
    transcription: String | null         // Original voice transcript
  },
  metadata: {
    photoUrls: [String],                 // User meal photos
    location: String | null,             // "Chipotle on 5th Ave"
    companions: [String] | null          // Social context
  },
  tags: [String],                        // "at-home", "meal-prep", "restaurant"
  notes: String,                         // User notes
  validated: Boolean,                    // True if AI-flagged items reviewed
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

**Validation:**
- `date`: Valid ISO8601 date string
- `mealType`: One of allowed values
- `items`: Array of valid food references
- `items[].quantity`: >0
- `totals`: Recalculated on item changes

**Indexes:**
- `date` (daily diary queries)
- `userId` (future: multi-device sync)

---

### 1.4 `recipes` (Templates)

Saved meal templates for reuse.

**Schema:**

```javascript
{
  id: UUID,
  name: String,                          // e.g., "Overnight Oats with Berries"
  description: String,                   // Detailed description
  servings: Number,                      // Total yield (e.g., 1, 2, 4)
  items: [
    {
      id: UUID,
      foodId: UUID,
      quantity: Number,
      unit: String,
      notes: String                      // e.g., "packed"
    }
  ],
  totals: {                              // Per serving
    kcal: Number,
    macros: {
      proteinG: Number,
      carbG: Number,
      fatG: Number
    },
    fiber: Number,
    sodium: Number
  },
  instructions: String,                  // Markdown format
  category: String,                      // "Breakfast", "Lunch", "Snack", "Dessert"
  tags: [String],                        // "vegetarian", "keto", "quick", "meal-prep"
  difficulty: "easy" | "medium" | "hard",
  prepTimeMin: Number,                   // Minutes
  cookTimeMin: Number,                   // Minutes
  photos: {
    thumbnail: String,
    full: [String]                       // Multiple photos
  },
  source: {
    type: "user" | "shared" | "api",
    authorId: UUID | null,               // Future: community recipes
    publicUrl: String | null
  },
  frequency: Number,                     // Times logged (popularity)
  favorites: Boolean,                    // Star for quick access
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

**Validation:**
- `name`: 1-200 characters
- `servings`: 1-100
- `items`: Non-empty array

---

### 1.5 `measurements` (Weight & Body Metrics)

Track weight, body composition, circumference measurements.

**Schema:**

```javascript
{
  id: UUID,
  date: "2026-04-06",                    // YYYY-MM-DD
  type: "weight" | "measurement" | "composition",
  value: Number,                         // 75.5 (kg or cm)
  unit: "kg" | "lb" | "cm" | "inch",
  bodyPart: String | null,               // "waist", "chest", "arm", "thigh"
  notes: String,                         // e.g., "morning, after bathroom"
  method: "scale" | "manual" | "device", // How measured
  confidence: 0.5 | 1.0,                 // 1.0 = high confidence
  bodyComposition: {                     // If type="composition"
    bodyFatPercent: Number | null,       // 25.5
    muscleMassKg: Number | null,         // 60.0
    waterPercent: Number | null,         // 60.0
    boneMassKg: Number | null
  },
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

**Validation:**
- `value`: 20-300 (for kg) or 40-600 (for lb)
- `date`: Valid ISO8601 date
- `confidence`: 0.0-1.0

**Indexes:**
- `date` (weight trend queries)

---

### 1.6 `aiConversations` (AI History, Optional)

Only created if BYOK enabled. Cache of AI requests/responses.

**Schema:**

```javascript
{
  id: UUID,
  type: "photo-analysis" | "voice-parsing" | "meal-suggestion" | "question",
  userInput: {
    text: String | null,
    imageBase64: String | null,          // Temporary during analysis
    audioTranscription: String | null    // Transcribed voice
  },
  aiResponse: {
    foods: [
      {
        name: String,
        confidence: 0.0 | 1.0,
        quantity: Number,
        unit: String,
        reason: String,                  // Explanation
        prepMethod: String | null
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
  error: String | null,                  // Error message if failed
  createdAt: ISO8601,
  updatedAt: ISO8601,
  deletedAt: ISO8601 | null
}
```

**Validation:**
- `type`: One of allowed values
- `tokens.estimatedCost`: >=0

**Indexes:** None (typically small table)

---

### 1.7 `syncLog` (Offline Sync Tracking)

Tracks pending operations for WebDAV/cloud sync.

**Schema:**

```javascript
{
  id: UUID,
  entityType: "meals" | "foods" | "recipes" | "measurements" | "users",
  entityId: UUID,
  operation: "create" | "update" | "delete",
  localVersion: Number,                  // Incremental version counter
  remoteVersion: Number | null,
  status: "pending" | "synced" | "conflict" | "error",
  lastSyncAt: ISO8601 | null,
  conflict: {
    resolved: Boolean,
    strategy: "local" | "remote" | "merge",
    mergeDetails: Object | null          // Custom merge logic
  },
  createdAt: ISO8601,
  updatedAt: ISO8601
}
```

**Indexes:**
- `status` (find pending syncs)
- `entityType` (group by type)

---

### 1.8 `apiCache` (API Response Cache)

Caching layer for external API responses (OFF, USDA).

**Schema:**

```javascript
{
  id: String,                            // MD5 hash of (apiName + query)
  apiName: "openFoodFacts" | "usdaFdc",
  query: String,                         // Original search term
  queryHash: String,                     // MD5(apiName + query)
  response: Object,                      // Full API JSON response
  parsedResult: Object,                  // Normalized to food schema
  ttl: Number,                           // Milliseconds (7 days or 30 days)
  expiresAt: ISO8601,                    // When to remove from cache
  hitCount: Number,                      // Cache hit tracking
  createdAt: ISO8601,
  updatedAt: ISO8601
}
```

**TTL Values:**
```javascript
const API_CACHE_TTL = {
  openFoodFacts: 7 * 24 * 60 * 60 * 1000,     // 7 days
  usdaFdc: 30 * 24 * 60 * 60 * 1000            // 30 days
};
```

**Indexes:**
- `expiresAt` (for cleanup/eviction)
- `queryHash` (to check for duplicates before API call)

---

## 2. Schema Initialization

```javascript
// src/data/schema.js
const SCHEMA_VERSION = 1;

export const stores = {
  users: { keyPath: 'id', indexes: [] },
  foods: {
    keyPath: 'id',
    indexes: [
      { name: 'name', keyPath: 'name' },
      { name: 'ean13', keyPath: 'barcode.ean13' },
      { name: 'source', keyPath: 'source.type' }
    ]
  },
  meals: {
    keyPath: 'id',
    indexes: [
      { name: 'date', keyPath: 'date' },
      { name: 'userId', keyPath: 'userId' }
    ]
  },
  recipes: { keyPath: 'id', indexes: [{ name: 'favorites', keyPath: 'favorites' }] },
  measurements: { keyPath: 'id', indexes: [{ name: 'date', keyPath: 'date' }] },
  aiConversations: { keyPath: 'id', indexes: [] },
  syncLog: {
    keyPath: 'id',
    indexes: [
      { name: 'status', keyPath: 'status' },
      { name: 'entityType', keyPath: 'entityType' }
    ]
  },
  apiCache: {
    keyPath: 'id',
    indexes: [
      { name: 'expiresAt', keyPath: 'expiresAt' },
      { name: 'queryHash', keyPath: 'queryHash' }
    ]
  }
};

export async function initSchema(db) {
  for (const [storeName, { keyPath, indexes }] of Object.entries(stores)) {
    if (!db.objectStoreNames.contains(storeName)) {
      const store = db.createObjectStore(storeName, { keyPath });
      indexes.forEach(idx => store.createIndex(idx.name, idx.keyPath));
    }
  }
}
```

---

## 3. Normalization Rules

### 3.1 Date Handling

**All date fields must be ISO8601 strings:**
```javascript
const date = new Date().toISOString();  // "2026-04-06T10:30:00.000Z"
```

**Meal date (YYYY-MM-DD for queries):**
```javascript
const dateKey = new Date().toISOString().split('T')[0];  // "2026-04-06"
```

### 3.2 Nutrient Calculations

**Per-serving nutrients always specified.** When scaling quantities:

```javascript
function scaleNutrients(food, quantity, unit) {
  // 1. Convert quantity to base unit (grams)
  const baseQty = convertToBaseUnit(quantity, unit, food);

  // 2. Calculate percentage of serving size
  const servingQty = convertToBaseUnit(
    food.servingSize.quantity,
    food.servingSize.unit,
    food
  );

  const multiplier = baseQty / servingQty;

  // 3. Scale all nutrients
  return {
    kcal: food.nutrients.energy.kcal * multiplier,
    protein: food.nutrients.macros.protein.g * multiplier,
    carbs: food.nutrients.macros.carbs.g * multiplier,
    fat: food.nutrients.macros.fat.g * multiplier
  };
}
```

### 3.3 Meal Totals Calculation

```javascript
function calculateMealTotals(meal) {
  const totals = {
    kcal: 0,
    macros: { proteinG: 0, carbG: 0, fatG: 0 },
    fiber: 0,
    sodium: 0,
    calcium: 0,
    iron: 0
  };

  meal.items.forEach(async item => {
    const food = await db.get('foods', item.foodId);
    const scaled = scaleNutrients(food, item.quantity, item.unit);

    totals.kcal += scaled.kcal;
    totals.macros.proteinG += scaled.protein;
    totals.macros.carbG += scaled.carbs;
    totals.macros.fatG += scaled.fat;
    totals.fiber += (food.nutrients.fiber?.g || 0) * scaled.multiplier;
    totals.sodium += (food.nutrients.sodium?.mg || 0) * scaled.multiplier;
  });

  return totals;
}
```

### 3.4 UUID Generation

```javascript
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
```

---

## 4. Query Patterns

### Daily Meals
```javascript
const today = new Date().toISOString().split('T')[0];
const meals = await db.getAllWhere('meals', 'date', today);
```

### Recent Foods (for quick-add)
```javascript
const recentMeals = await db.getAllWhere('meals', 'date', IDBKeyRange.lowerBound(
  new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
));

const foods = new Set();
recentMeals.forEach(meal => {
  meal.items.forEach(item => foods.add(item.foodId));
});
```

### Food Search
```javascript
const localFoods = await db.getAllWhere('foods', 'name', IDBKeyRange.bound(
  query.toLowerCase(),
  query.toLowerCase() + '\uffff'  // Unicode range
));
```

### Weight Trend (Last 30 Days)
```javascript
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const measurements = await db.getAllWhere('measurements', 'date', IDBKeyRange.lowerBound(thirtyDaysAgo));
const weights = measurements.filter(m => m.type === 'weight');
```

---

## 5. Import/Export Formats

### Full Backup (JSON)

```json
{
  "version": 1,
  "exportedAt": "2026-04-06T10:30:00.000Z",
  "appVersion": "1.0.0",
  "users": [{ "id": "user-1", ... }],
  "foods": [{ "id": "uuid", ... }],
  "meals": [{ "id": "uuid", ... }],
  "recipes": [{ "id": "uuid", ... }],
  "measurements": [{ "id": "uuid", ... }]
}
```

### Diary Export (CSV)

```csv
date,time,mealType,foodName,quantity,unit,kcal,protein,carbs,fat,fiber,sodium
2026-04-06,08:00,breakfast,Eggs,2,piece,155,13,1,11,0,140
2026-04-06,08:00,breakfast,Whole Wheat Toast,1,slice,80,3,14,1,2,120
```

---

This data model ensures:
- **Consistency:** All fields validated on write
- **Efficiency:** Strategic indexing for common queries
- **Flexibility:** Extensible for future fields
- **Privacy:** Personal data stored locally only
- **Reliability:** Backup-friendly formats
