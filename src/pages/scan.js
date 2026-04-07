import { lookupBarcode } from '../integrations/openfoodfacts.js';
import { searchFoods, getRecentFoods, getFavoriteFoods } from '../engine/food-search.js';
import { getById, put } from '../data/db.js';
import { todayStr } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { getUnitsForFood, getNutritionMultiplier } from '../utils/units.js';

let Quagga = null;
let scannerActive = false;

async function loadQuagga() {
  if (Quagga) return Quagga;
  try {
    const mod = await import('@ericblade/quagga2');
    Quagga = mod.default || mod;
    return Quagga;
  } catch (err) {
    console.warn('QuaggaJS not available:', err);
    return null;
  }
}

export function renderScanPage(container, queryString) {
  const params = new URLSearchParams(queryString);
  const mealTypeParam = params.get('meal') || getMealTypeForTime();

  let searchQuery = '';
  let searchTimeout;
  let barcodeInput = '';
  let cameraStarted = false;

  async function render() {
    const recentFoods = await getRecentFoods(5);
    const frequentFoods = await getFavoriteFoods(5);

    container.innerHTML = `
      <div class="scan-page" role="main" aria-label="Add food">
        <!-- Unified Search Bar -->
        <div class="search-header">
          <div class="search-input-wrapper">
            <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input
              type="text"
              class="search-input"
              id="unified-search-input"
              placeholder="Search foods or enter barcode..."
              autocomplete="off"
              aria-label="Search for foods or enter a barcode number"
            >
          </div>
        </div>

        <!-- Camera Scanner Section -->
        <div class="scan-camera-section">
          <div class="scanner-camera-container" id="scanner-container">
            <div id="scanner-viewport" style="width:100%;height:100%"></div>
            <div class="scanner-reticle" id="scanner-reticle" style="display:none"></div>
          </div>
          <div class="scanner-controls">
            <button class="btn btn-primary btn-small" id="start-camera-btn" aria-label="Start barcode camera scanner">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              Scan Barcode
            </button>
            <button class="btn btn-secondary btn-small" id="stop-camera-btn" style="display:none" aria-label="Stop camera">
              Stop Camera
            </button>
          </div>
        </div>

        <div class="scanner-or-divider">or search below</div>

        <!-- Search Results / Initial Content -->
        <div id="scan-search-content" class="search-content">
          ${recentFoods.length > 0 ? `
            <section class="search-section">
              <h3 class="section-title">Recent Foods</h3>
              <div class="food-results">
                ${recentFoods.map(food => renderFoodResult(food)).join('')}
              </div>
            </section>
          ` : ''}
          ${frequentFoods.length > 0 ? `
            <section class="search-section">
              <h3 class="section-title">Frequent Foods</h3>
              <div class="food-results">
                ${frequentFoods.map(food => renderFoodResult(food)).join('')}
              </div>
            </section>
          ` : ''}
          ${recentFoods.length === 0 && frequentFoods.length === 0 ? `
            <div class="search-empty"><p>Scan a barcode or search for foods to log</p></div>
          ` : ''}
        </div>

        <!-- Barcode Lookup Result -->
        <div id="scan-result" class="scan-result-container"></div>

        <div class="scan-alternatives">
          <button class="btn btn-outline btn-small" id="add-custom-food-btn">Add Custom Food</button>
        </div>
      </div>
    `;

    // Wire up event listeners
    const searchInput = document.getElementById('unified-search-input');
    searchInput.focus();

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      clearTimeout(searchTimeout);

      if (!searchQuery) {
        render();
        return;
      }

      // Check if input looks like a barcode (all digits, 8-13 chars)
      if (/^\d{8,13}$/.test(searchQuery)) {
        performBarcodeLookup(searchQuery);
        return;
      }

      searchTimeout = setTimeout(() => performSearch(), 300);
    });

    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && /^\d{8,13}$/.test(searchQuery)) {
        performBarcodeLookup(searchQuery);
      }
    });

    // Camera controls
    document.getElementById('start-camera-btn').addEventListener('click', startCamera);
    document.getElementById('stop-camera-btn').addEventListener('click', stopCamera);
    document.getElementById('add-custom-food-btn')?.addEventListener('click', openCustomFoodForm);

    // Wire food result clicks
    wireFoodResultClicks([...recentFoods, ...frequentFoods]);
  }

  async function startCamera() {
    const Q = await loadQuagga();
    if (!Q) {
      showToast('Camera scanning not available in this browser');
      return;
    }

    const viewport = document.getElementById('scanner-viewport');
    const startBtn = document.getElementById('start-camera-btn');
    const stopBtn = document.getElementById('stop-camera-btn');
    const reticle = document.getElementById('scanner-reticle');

    startBtn.style.display = 'none';
    stopBtn.style.display = '';
    reticle.style.display = '';
    scannerActive = true;

    try {
      await new Promise((resolve, reject) => {
        Q.init({
          inputStream: {
            type: 'LiveStream',
            target: viewport,
            constraints: {
              facingMode: 'environment',
              width: { ideal: 640 },
              height: { ideal: 480 },
            },
          },
          decoder: {
            readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'],
          },
          locate: true,
          frequency: 10,
        }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      Q.start();
      cameraStarted = true;

      Q.onDetected(async (result) => {
        const code = result?.codeResult?.code;
        if (code && scannerActive) {
          scannerActive = false; // Prevent multiple detections
          stopCamera();
          document.getElementById('unified-search-input').value = code;
          performBarcodeLookup(code);
        }
      });
    } catch (err) {
      console.error('Camera init error:', err);
      showToast('Could not access camera. Please enter barcode manually.');
      stopCamera();
    }
  }

  function stopCamera() {
    if (Quagga && cameraStarted) {
      try { Quagga.stop(); } catch (e) { /* ignore */ }
      cameraStarted = false;
    }
    scannerActive = false;

    const startBtn = document.getElementById('start-camera-btn');
    const stopBtn = document.getElementById('stop-camera-btn');
    const reticle = document.getElementById('scanner-reticle');
    if (startBtn) startBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
    if (reticle) reticle.style.display = 'none';
  }

  async function performBarcodeLookup(code) {
    const contentDiv = document.getElementById('scan-search-content');
    const resultDiv = document.getElementById('scan-result');
    contentDiv.innerHTML = '<div class="search-loading">Looking up barcode...</div>';
    resultDiv.innerHTML = '';

    try {
      const food = await lookupBarcode(code);
      if (!food) {
        contentDiv.innerHTML = `
          <div class="search-empty">
            <p>Barcode <strong>${escapeHTML(code)}</strong> not found</p>
            <p class="search-suggestion">Try searching by name instead</p>
          </div>
        `;
        showToast('Barcode not found');
      } else {
        contentDiv.innerHTML = `
          <section class="search-section">
            <h3 class="section-title">Barcode Match</h3>
            <div class="food-results">
              ${renderFoodResult(food)}
            </div>
          </section>
        `;
        wireFoodResultClicks([food]);
      }
    } catch (err) {
      console.error('Barcode lookup error:', err);
      contentDiv.innerHTML = '<div class="search-error"><p>Error looking up barcode</p></div>';
      showToast('Error looking up barcode');
    }
  }

  async function performSearch() {
    const contentDiv = document.getElementById('scan-search-content');
    contentDiv.innerHTML = '<div class="search-loading">Searching...</div>';

    try {
      const results = await searchFoods(searchQuery, { localOnly: false, limit: 20 });
      if (!results || results.length === 0) {
        contentDiv.innerHTML = `
          <div class="search-empty">
            <p>No foods found for "${escapeHTML(searchQuery)}"</p>
            <p class="search-suggestion">Try different keywords or add a custom food</p>
          </div>
        `;
        return;
      }

      contentDiv.innerHTML = `
        <section class="search-section">
          <h3 class="section-title">Search Results</h3>
          <div class="food-results">
            ${results.map(food => renderFoodResult(food)).join('')}
          </div>
        </section>
      `;
      wireFoodResultClicks(results);
    } catch (err) {
      console.error('Search error:', err);
      contentDiv.innerHTML = '<div class="search-error"><p>Error searching foods</p></div>';
    }
  }

  function wireFoodResultClicks(foods) {
    document.querySelectorAll('.food-result-item').forEach(el => {
      el.addEventListener('click', async () => {
        const foodId = el.dataset.foodId;
        const food = foods.find(f => f.id === foodId) || await getById('foods', foodId);
        if (food) openPortionModal(food, mealTypeParam);
      });
    });
  }

  function openPortionModal(food, mealType) {
    const baseNutrition = {
      calories: food.nutrients?.energy?.kcal || 0,
      protein: food.nutrients?.macros?.protein?.g || 0,
      carbs: food.nutrients?.macros?.carbs?.g || 0,
      fat: food.nutrients?.macros?.fat?.g || 0,
    };

    let quantity = food.servingSize?.quantity || 100;
    let unit = food.servingSize?.unit || 'g';
    let selectedMealType = mealType;
    const availableUnits = getUnitsForFood(food);

    function updatePreview() {
      const multiplier = getNutritionMultiplier(quantity, unit, food);
      const preview = document.getElementById('nutrition-preview');
      if (preview) {
        preview.innerHTML = `
          <div class="nutrition-preview">
            <div class="preview-stat"><span class="preview-label">Calories</span><span class="preview-value">${Math.round(baseNutrition.calories * multiplier)} kcal</span></div>
            <div class="preview-stat"><span class="preview-label">Protein</span><span class="preview-value">${(baseNutrition.protein * multiplier).toFixed(1)}g</span></div>
            <div class="preview-stat"><span class="preview-label">Carbs</span><span class="preview-value">${(baseNutrition.carbs * multiplier).toFixed(1)}g</span></div>
            <div class="preview-stat"><span class="preview-label">Fat</span><span class="preview-value">${(baseNutrition.fat * multiplier).toFixed(1)}g</span></div>
          </div>
        `;
      }
    }

    const modal = document.createElement('div');
    modal.className = 'modal-content portion-editor';
    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHTML(food.name)}</h2>
          ${food.brand ? `<p class="modal-subtitle">${escapeHTML(food.brand)}</p>` : ''}
        </div>
        <button class="modal-close" id="modal-close" aria-label="Close">✕</button>
      </div>
      <div class="portion-controls">
        <label class="control-group">
          <span class="control-label">Quantity</span>
          <div class="quantity-input-group">
            <button class="qty-btn qty-minus" id="qty-minus" aria-label="Decrease quantity">−</button>
            <input type="number" class="qty-input" id="qty-input" value="${quantity}" min="0.1" step="0.1" aria-label="Quantity">
            <button class="qty-btn qty-plus" id="qty-plus" aria-label="Increase quantity">+</button>
          </div>
        </label>
        <label class="control-group">
          <span class="control-label">Unit</span>
          <select class="unit-select" id="unit-select" aria-label="Unit of measurement">
            ${availableUnits.map(u => `<option value="${u.value}" ${u.value === unit ? 'selected' : ''}>${u.label}</option>`).join('')}
          </select>
        </label>
        <label class="control-group">
          <span class="control-label">Meal Type</span>
          <select class="meal-type-select" id="meal-type-select" aria-label="Meal type">
            <option value="breakfast" ${selectedMealType === 'breakfast' ? 'selected' : ''}>Breakfast</option>
            <option value="lunch" ${selectedMealType === 'lunch' ? 'selected' : ''}>Lunch</option>
            <option value="dinner" ${selectedMealType === 'dinner' ? 'selected' : ''}>Dinner</option>
            <option value="snacks" ${selectedMealType === 'snacks' ? 'selected' : ''}>Snacks</option>
          </select>
        </label>
      </div>
      <div id="nutrition-preview"></div>
      <label class="control-group">
        <span class="control-label">Notes (optional)</span>
        <input type="text" class="notes-input" id="notes-input" placeholder="e.g., with milk, extra dressing" aria-label="Notes">
      </label>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="log-btn">Log Food</button>
      </div>
    `;

    openModal(modal);

    const qtyInput = document.getElementById('qty-input');
    const unitSelect = document.getElementById('unit-select');
    const mealTypeSelect = document.getElementById('meal-type-select');
    const notesInput = document.getElementById('notes-input');

    document.getElementById('qty-minus').addEventListener('click', () => {
      qtyInput.value = Math.max(0.1, parseFloat(qtyInput.value) - 0.5);
      quantity = parseFloat(qtyInput.value);
      updatePreview();
    });

    document.getElementById('qty-plus').addEventListener('click', () => {
      qtyInput.value = (parseFloat(qtyInput.value) + 0.5).toFixed(1);
      quantity = parseFloat(qtyInput.value);
      updatePreview();
    });

    qtyInput.addEventListener('change', () => {
      quantity = parseFloat(qtyInput.value) || 100;
      updatePreview();
    });

    unitSelect?.addEventListener('change', (e) => { unit = e.target.value; updatePreview(); });
    mealTypeSelect.addEventListener('change', (e) => { selectedMealType = e.target.value; });
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('cancel-btn').addEventListener('click', closeModal);

    document.getElementById('log-btn').addEventListener('click', async () => {
      await logFood(food, quantity, unit, selectedMealType, notesInput.value);
    });

    updatePreview();
  }

  async function logFood(food, quantity, unit, mealType, notes) {
    try {
      if (!food.id) food.id = generateId();
      const existing = await getById('foods', food.id);
      if (!existing) await put('foods', food);

      const multiplier = getNutritionMultiplier(quantity, unit, food);
      const scaledNutrients = {
        kcal: (food.nutrients?.energy?.kcal || 0) * multiplier,
        protein: (food.nutrients?.macros?.protein?.g || 0) * multiplier,
        carbs: (food.nutrients?.macros?.carbs?.g || 0) * multiplier,
        fat: (food.nutrients?.macros?.fat?.g || 0) * multiplier,
        fiber: (food.nutrients?.fiber?.g || 0) * multiplier,
        sodium: (food.nutrients?.sodium?.mg || 0) * multiplier,
      };

      await put('meals', {
        id: generateId(),
        date: todayStr(),
        type: mealType.toLowerCase(),
        items: [{ foodId: food.id, quantity, unit, notes, nutrients: scaledNutrients }],
        createdAt: new Date().toISOString(),
      });

      showToast(`${food.name} logged to ${mealType}`);
      closeModal();
      setTimeout(() => { window.location.hash = '#/diary'; }, 500);
    } catch (err) {
      console.error('Error logging food:', err);
      showToast('Failed to log food');
    }
  }

  function openCustomFoodForm() {
    const modal = document.createElement('div');
    modal.className = 'modal-content custom-food-form';
    modal.innerHTML = `
      <div class="modal-header">
        <h2>Add Custom Food</h2>
        <button class="modal-close" id="modal-close" aria-label="Close">✕</button>
      </div>
      <div class="form-group">
        <label><span class="control-label">Food Name</span>
          <input type="text" id="custom-name" placeholder="e.g., Homemade pasta" class="form-input" aria-label="Food name">
        </label>
      </div>
      <div class="form-row">
        <label class="form-group"><span class="control-label">Calories per 100g</span>
          <input type="number" id="custom-kcal" placeholder="0" class="form-input" min="0" aria-label="Calories per 100 grams">
        </label>
        <label class="form-group"><span class="control-label">Protein (g)</span>
          <input type="number" id="custom-protein" placeholder="0" class="form-input" min="0" step="0.1" aria-label="Protein in grams">
        </label>
      </div>
      <div class="form-row">
        <label class="form-group"><span class="control-label">Carbs (g)</span>
          <input type="number" id="custom-carbs" placeholder="0" class="form-input" min="0" step="0.1" aria-label="Carbs in grams">
        </label>
        <label class="form-group"><span class="control-label">Fat (g)</span>
          <input type="number" id="custom-fat" placeholder="0" class="form-input" min="0" step="0.1" aria-label="Fat in grams">
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="save-btn">Add Food</button>
      </div>
    `;

    openModal(modal);

    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('cancel-btn').addEventListener('click', closeModal);

    document.getElementById('save-btn').addEventListener('click', () => {
      const name = document.getElementById('custom-name').value.trim();
      const kcal = parseFloat(document.getElementById('custom-kcal').value) || 0;
      const protein = parseFloat(document.getElementById('custom-protein').value) || 0;
      const carbs = parseFloat(document.getElementById('custom-carbs').value) || 0;
      const fat = parseFloat(document.getElementById('custom-fat').value) || 0;

      if (!name || kcal <= 0) {
        showToast('Please fill in food name and calories');
        return;
      }

      const customFood = {
        id: generateId(),
        name,
        nutrients: {
          energy: { kcal },
          macros: { protein: { g: protein }, carbs: { g: carbs }, fat: { g: fat } },
          fiber: { g: 0 },
          sodium: { mg: 0 },
        },
        servingSize: { quantity: 100, unit: 'g', aliases: [] },
        source: { type: 'custom' },
        createdAt: new Date().toISOString(),
      };

      closeModal();
      setTimeout(() => openPortionModal(customFood, mealTypeParam), 200);
    });
  }

  render();

  // Cleanup camera on page leave
  return () => {
    if (cameraStarted) stopCamera();
  };
}

function renderFoodResult(food) {
  const protein = food.nutrients?.macros?.protein?.g || 0;
  const carbs = food.nutrients?.macros?.carbs?.g || 0;
  const fat = food.nutrients?.macros?.fat?.g || 0;
  const kcal = food.nutrients?.energy?.kcal || 0;
  const macroSummary = `${Math.round(protein)}P ${Math.round(carbs)}C ${Math.round(fat)}F`;
  const servingLabel = food.servingSize ? `${food.servingSize.quantity}${food.servingSize.unit}` : '100g';
  const sourceType = food.source?.type || '';
  const sourceBadge = sourceType ? `<span class="source-badge ${sourceType}">${sourceType.toUpperCase()}</span>` : '';

  return `
    <div class="food-result-item" data-food-id="${food.id}" role="button" tabindex="0" aria-label="${escapeHTML(food.name)}, ${Math.round(kcal)} calories per ${servingLabel}">
      <div class="food-result-info">
        <div class="food-result-name">${escapeHTML(food.name)}</div>
        ${food.brand ? `<div class="food-result-brand">${escapeHTML(food.brand)}</div>` : ''}
        <div class="food-result-meta">
          <span class="kcal-badge">${Math.round(kcal)} kcal/${servingLabel}</span>
          <span class="macro-summary">${macroSummary}</span>
          ${sourceBadge}
        </div>
      </div>
      <div class="food-result-action" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </div>
    </div>
  `;
}

function getMealTypeForTime() {
  const hour = new Date().getHours();
  if (hour < 12) return 'breakfast';
  if (hour < 17) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snacks';
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
