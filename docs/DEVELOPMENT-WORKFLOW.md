# LibreLog Development Workflow

**Status:** Developer Guide
**Updated:** April 2026

Quick reference for common development tasks, code organization, and contribution guidelines.

---

## 1. PROJECT STRUCTURE QUICK REFERENCE

```
librelog/
├── src/
│   ├── app.js                    # Main SPA entry point
│   ├── index.html                # HTML template
│   ├── manifest.webmanifest      # PWA metadata
│   │
│   ├── pages/                    # Route handlers
│   │   ├── diary.js
│   │   ├── foodSearch.js
│   │   ├── mealBuilder.js
│   │   ├── goals.js
│   │   ├── settings.js
│   │   ├── weightTracker.js
│   │   ├── recipes.js
│   │   ├── aiChat.js
│   │   └── about.js
│   │
│   ├── components/               # Reusable UI modules
│   │   ├── nutritionCard.js
│   │   ├── mealCard.js
│   │   ├── foodSearch.js
│   │   ├── barcodeScan.js
│   │   ├── recipeListing.js
│   │   ├── nutritionTable.js
│   │   ├── chart.js
│   │   ├── modal.js
│   │   ├── tabs.js
│   │   └── loadingSpinner.js
│   │
│   ├── data/                     # Data layer
│   │   ├── db.js                 # IndexedDB wrapper
│   │   ├── schema.js             # Schema + migrations
│   │   ├── state.js              # In-memory state
│   │   ├── import-export.js
│   │   ├── webdav.js
│   │   ├── seedData.js
│   │   └── sync.js
│   │
│   ├── engine/                   # Business logic
│   │   ├── nutrition.js
│   │   ├── goalTracking.js
│   │   ├── foodSearch.js
│   │   ├── mealCalculator.js
│   │   ├── recipeMachine.js
│   │   ├── weightAnalysis.js
│   │   └── validation.js
│   │
│   ├── integrations/             # External APIs
│   │   ├── openFoodFacts.js
│   │   ├── usdaFdc.js
│   │   ├── aiClient.js
│   │   ├── imageProcessor.js
│   │   ├── voiceParser.js
│   │   └── cache.js
│   │
│   ├── utils/                    # Helpers
│   │   ├── format.js
│   │   ├── storage.js
│   │   ├── haptics.js
│   │   ├── sanitize.js
│   │   ├── validation.js
│   │   ├── error.js
│   │   └── debug.js
│   │
│   └── styles/
│       ├── index.css
│       ├── components.css
│       ├── themes.css
│       └── responsive.css
│
├── docs/                         # Documentation
│   ├── ARCHITECTURE.md
│   ├── DATA-MODEL.md
│   ├── API-INTEGRATION.md
│   ├── SECURITY.md
│   ├── DEPLOYMENT.md
│   └── DEVELOPMENT-WORKFLOW.md
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── vite.config.js
├── package.json
├── capacitor.config.json
├── .gitignore
├── README.md
├── CHANGELOG.md
├── LICENSE
└── ARCHITECTURE.md (project overview)
```

---

## 2. CODING CONVENTIONS

### 2.1 File Organization

```javascript
// src/pages/diary.js
// 1. Imports
import { db } from '../data/db.js';
import { calculateMealTotals } from '../engine/nutrition.js';
import { MealCard } from '../components/mealCard.js';

// 2. Constants
const MEALS_PER_PAGE = 30;

// 3. State (if needed)
let currentDate = new Date();

// 4. Main exports
export async function renderDiary() { ... }

// 5. Helper functions
async function loadTodayMeals() { ... }
function formatMealCard(meal) { ... }
```

### 2.2 Naming Conventions

```javascript
// Classes: PascalCase
class FoodSearchEngine { ... }

// Functions: camelCase
async function searchFoods(query) { ... }

// Constants: UPPER_SNAKE_CASE
const API_TIMEOUT = 5000;
const VALID_UNITS = ['g', 'oz', 'cup'];

// DOM elements: descriptive + 'Element' suffix
const mealCardElement = document.querySelector('.meal-card');
const saveButtonElement = document.getElementById('save-meal');

// Database operations: verb + noun
const meal = await db.get('meals', mealId);
const foods = await db.getAllWhere('foods', 'category', 'Dairy');
await db.put('meals', meal);
await db.delete('meals', mealId);
```

### 2.3 Code Style

```javascript
// Use const by default, let if reassigned
const user = await db.get('users', 'user-1');
let mealCount = 0;

// Arrow functions for callbacks
[1, 2, 3].map(n => n * 2);

// Async/await over .then()
const meals = await db.getAllWhere('meals', 'date', today);

// Null coalescing & optional chaining
const name = user?.profile?.name ?? 'Unknown';
const kcal = food.nutrients?.energy?.kcal ?? 0;

// Template literals
const message = `Logged ${meal.items.length} items: ${meal.totals.kcal} kcal`;

// Destructuring
const { totals: { kcal }, items } = meal;
```

---

## 3. COMMON DEVELOPMENT TASKS

### 3.1 Adding a New Page

```javascript
// 1. Create src/pages/newPage.js
export async function renderNewPage() {
  const container = document.querySelector('#app');

  // Build HTML
  const html = `
    <div class="page new-page">
      <header class="page-header">
        <h1>New Feature</h1>
      </header>
      <main class="page-content">
        <!-- Content here -->
      </main>
    </div>
  `;

  container.innerHTML = html;

  // Attach event listeners
  setupEventListeners();

  // Load data
  await loadData();
}

function setupEventListeners() {
  document.querySelector('.btn-save').addEventListener('click', handleSave);
}

async function loadData() {
  const data = await db.getAll('table');
  // ...
}
```

### 3.2 Adding a New API Integration

```javascript
// 1. Create src/integrations/newAPI.js
export class NewAPIClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.example.com';
  }

  async search(query) {
    // 1. Check cache
    const cached = await this._getCache(query);
    if (cached) return cached;

    // 2. Fetch from API
    const response = await this._fetch(`/search?q=${query}`);
    if (!response.ok) return null;

    const data = await response.json();

    // 3. Normalize to food schema
    const normalized = data.results.map(normalizeResult);

    // 4. Cache
    await this._setCache(query, normalized);

    return normalized;
  }

  async _fetch(path) {
    return fetch(this.baseUrl + path, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(5000)
    });
  }

  async _getCache(key) {
    const cached = await db.get('apiCache', key);
    if (cached && new Date(cached.expiresAt) > new Date()) {
      return cached.result;
    }
    return null;
  }

  async _setCache(key, result) {
    await db.put('apiCache', {
      id: key,
      result,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
  }
}

function normalizeResult(result) {
  // Map API response to food schema
}
```

### 3.3 Writing Tests

```javascript
// tests/unit/nutrition.test.js
import { describe, it, expect } from 'vitest';
import { calculateMealTotals, scaleNutrients } from '../../src/engine/nutrition.js';

describe('Nutrition Engine', () => {
  it('should calculate meal totals correctly', () => {
    const meal = {
      items: [
        {
          foodId: 'chicken-1',
          quantity: 150,
          unit: 'g'
        }
      ]
    };

    const totals = calculateMealTotals(meal);

    expect(totals.kcal).toBeGreaterThan(0);
    expect(totals.macros.proteinG).toBeGreaterThan(20);
  });

  it('should scale nutrients by quantity', () => {
    const food = {
      nutrients: {
        energy: { kcal: 165, kJ: 690 },
        macros: { protein: { g: 31 }, carbs: { g: 0 }, fat: { g: 3.6 } }
      },
      servingSize: { quantity: 100, unit: 'g' }
    };

    const scaled = scaleNutrients(food, 150, 'g');

    expect(scaled.kcal).toBe(247.5);  // 165 * 1.5
    expect(scaled.proteinG).toBe(46.5);
  });
});
```

### 3.4 Implementing Offline Support

```javascript
// 1. Store data in IndexedDB first
async function logMeal(mealData) {
  const meal = {
    id: uuidv4(),
    ...mealData,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Save locally immediately
  await db.put('meals', meal);

  // Create sync record
  await db.put('syncLog', {
    id: uuidv4(),
    entityType: 'meals',
    entityId: meal.id,
    operation: 'create',
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  // Update UI optimistically
  updateDiaryUI();

  // Sync when online
  if (navigator.onLine) {
    scheduleSync();
  }
}

// 2. Sync on reconnect
window.addEventListener('online', () => {
  console.log('Online, syncing...');
  performSync();
});

async function performSync() {
  const pending = await db.getAllWhere('syncLog', 'status', 'pending');

  for (const record of pending) {
    try {
      const entity = await db.get(record.entityType, record.entityId);
      await uploadToRemote(entity);
      record.status = 'synced';
      await db.put('syncLog', record);
    } catch (error) {
      console.error('Sync failed:', error);
      record.status = 'error';
      await db.put('syncLog', record);
    }
  }
}
```

---

## 4. GIT WORKFLOW

### 4.1 Branching Strategy

```bash
# Main branches
main        # Production-ready code
develop     # Integration branch for next release

# Feature branches
feature/meal-builder        # New feature
feature/ai-photo-analysis

# Bug fix branches
bugfix/weight-calculation
bugfix/sync-conflict

# Release branches
release/v1.1.0
```

### 4.2 Commit Messages

```bash
# Format: <type>(<scope>): <subject>
#
# Types: feat, fix, docs, style, refactor, test, chore
# Scope: Optional, e.g., nutrition, api, ui
# Subject: Imperative, lowercase, no period

feat(nutrition): add custom macro targets
fix(api): retry failed OFF requests with exponential backoff
docs(deployment): update iOS build instructions
chore(deps): update vite to 6.1.0
```

### 4.3 Creating a Merge Request

```bash
# 1. Create feature branch
git checkout -b feature/new-feature
git push -u origin feature/new-feature

# 2. Make commits
git add src/pages/newPage.js
git commit -m "feat(pages): add meal builder page"

# 3. Push changes
git push origin feature/new-feature

# 4. Create PR on GitHub
# - Title: Brief description
# - Description: Why, what, how
# - Link related issues
# - Request reviewers

# 5. Address review feedback
git add .
git commit -m "review: simplify meal totals calculation"
git push origin feature/new-feature

# 6. Merge to develop
# (GitHub: Merge button in PR)
```

---

## 5. DEBUGGING TIPS

### 5.1 Browser DevTools

```javascript
// View IndexedDB contents
// DevTools → Application → IndexedDB → librelog

// Check service worker
// DevTools → Application → Service Workers

// Console commands
const meals = await db.getAll('meals');
console.table(meals);

const foods = await foodSearchEngine.search('chicken');
console.log(foods);

// Enable debug logging
localStorage.setItem('DEBUG', 'true');
window.location.reload();
```

### 5.2 Common Issues

**IndexedDB not persisting:**
```javascript
// Check quota
navigator.storage.estimate().then(estimate => {
  console.log(`Used: ${estimate.usage}B, Quota: ${estimate.quota}B`);
});

// Request persistent storage
navigator.storage.persist().then(persistent => {
  console.log(`Persistent: ${persistent}`);
});
```

**Service worker not updating:**
```javascript
// Unregister and re-register
navigator.serviceWorker.getRegistrations().then(regs => {
  regs.forEach(reg => reg.unregister());
});
location.reload();
```

**API calls failing:**
```javascript
// Check network tab in DevTools
// Enable throttling: DevTools → Network → Slow 3G
// Test offline: DevTools → Network → Offline

// Check CSP violations
// DevTools → Console (errors)
```

---

## 6. DOCUMENTATION

### 6.1 Code Comments

```javascript
// Good: Explains WHY, not what code does
// Retry with exponential backoff to avoid overwhelming the API
for (let i = 0; i < maxRetries; i++) {
  try {
    return await fetch(url);
  } catch {
    await sleep(Math.pow(2, i) * 1000);
  }
}

// Bad: Obvious from code
// Loop through meals
meals.forEach(meal => { ... });
```

### 6.2 JSDoc for Complex Functions

```javascript
/**
 * Calculate total nutrition for a meal
 * @param {Object} meal - Meal object with items array
 * @param {Array} meal.items - Food items with quantities
 * @returns {Object} Totals with kcal, macros, fiber, sodium
 * @throws {Error} If food not found in database
 */
export async function calculateMealTotals(meal) {
  // ...
}
```

### 6.3 README for New Features

```markdown
## Feature: Meal Builder

### Overview
Allows users to create custom recipes from multiple foods.

### Usage
1. Navigate to Recipes → New Recipe
2. Add foods using search or barcode
3. Adjust quantities
4. Save as reusable template

### Implementation
- Page: `src/pages/mealBuilder.js`
- Component: `src/components/recipeListing.js`
- Engine: `src/engine/recipeMachine.js`
```

---

## 7. PERFORMANCE OPTIMIZATION

### 7.1 Identify Bottlenecks

```javascript
// Use performance API
performance.mark('search-start');
const results = await foodSearchEngine.search(query);
performance.mark('search-end');
performance.measure('search', 'search-start', 'search-end');

const measure = performance.getEntriesByName('search')[0];
console.log(`Search took ${measure.duration}ms`);
```

### 7.2 Optimize Common Tasks

```javascript
// Cache frequently accessed data
const userProfile = await db.get('users', 'user-1');
stateManager.setUserProfile(userProfile);  // Store in memory

// Use pagination for large datasets
const meals = await db.getAllWhere('meals', 'date',
  IDBKeyRange.lowerBound(startDate)
).slice(0, 30);  // First 30

// Debounce search input
let searchTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    performSearch(e.target.value);
  }, 300);
});
```

---

## 8. RELEASE CHECKLIST

Before committing to main/develop:

- [ ] Code follows conventions
- [ ] Tests passing (if added)
- [ ] No console.errors
- [ ] Documentation updated (if needed)
- [ ] No sensitive data in code
- [ ] Performance acceptable
- [ ] Offline functionality works
- [ ] Feature tested on mobile device
- [ ] Commit message clear and descriptive

---

## 9. RESOURCES

### Documentation
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System design
- [DATA-MODEL.md](./DATA-MODEL.md) - Schema reference
- [API-INTEGRATION.md](./API-INTEGRATION.md) - API client patterns
- [SECURITY.md](./SECURITY.md) - Security guidelines
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Release process

### External
- [Vite Docs](https://vitejs.dev)
- [Capacitor Docs](https://capacitorjs.com)
- [IndexedDB MDN](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [PWA Guide](https://web.dev/progressive-web-apps/)

---

This development guide covers:
- Project structure and navigation
- Coding standards and conventions
- Common development tasks
- Git workflow
- Debugging techniques
- Documentation practices
- Performance optimization
- Release checklist
