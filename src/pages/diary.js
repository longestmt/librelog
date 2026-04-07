import { getById, getByIndex, getAll, put, softDelete, getSetting, setSetting } from '../data/db.js';
import { getGoals } from '../engine/goal-tracking.js';
import { calculateDayTotalsSimple } from '../engine/nutrition.js';
import { todayStr, formatDate } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { getUnitsForFood, getNutritionMultiplier } from '../utils/units.js';
import { getRecentFoods } from '../engine/food-search.js';

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function addDays(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

export function renderDiaryPage(container, queryString) {
  let currentDate = todayStr();

  async function render() {
    const meals = await getByIndex('meals', 'date', currentDate) || [];
    const goals = await getGoals();
    const dailyNote = await getSetting(`note_${currentDate}`) || '';

    const totals = calculateDayTotalsSimple(meals);
    const caloriesRemaining = Math.max(0, goals.calorieTarget - totals.kcal);

    const nutritionRingSVG = createNutritionRing(totals.kcal, goals.calorieTarget);

    const mealSections = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
    const mealsByType = groupMealsByType(meals);

    // Pre-fetch all foods needed for rendering
    const foodIds = new Set();
    meals.forEach(meal => {
      (meal.items || []).forEach(item => {
        foodIds.add(item.foodId);
      });
    });
    const foodsMap = new Map();
    for (const foodId of foodIds) {
      const food = await getById('foods', foodId);
      if (food) {
        foodsMap.set(foodId, food);
      }
    }

    // Get recent foods for carousel
    const recentFoods = await getRecentFoods(10);

    container.innerHTML = `
      <div class="diary-page" role="main" aria-label="Daily food diary">
        <!-- Date Navigation Header -->
        <div class="date-header" role="navigation" aria-label="Date navigation">
          <button class="date-nav-btn" id="prev-day" aria-label="Previous day">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          <div class="date-display">
            <div class="date-label">
              <span id="date-text">${formatDate(currentDate)}</span>
            </div>
            <button class="today-btn" id="today-btn">Today</button>
          </div>
          <button class="date-nav-btn" id="next-day" aria-label="Next day">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>

        <!-- Nutrition Ring and Macros -->
        <div class="nutrition-summary" role="region" aria-label="Nutrition summary">
          <div class="nutrition-ring-container">
            ${nutritionRingSVG}
            <div class="ring-text">
              <div class="ring-main">${totals.kcal}</div>
              <div class="ring-sub">of ${goals.calorieTarget}</div>
            </div>
          </div>
          <div class="macro-bars">
            <div class="macro-bar" role="progressbar" aria-valuenow="${Math.round(totals.protein)}" aria-valuemax="${goals.proteinG}" aria-label="Protein progress">
              <div class="macro-header">
                <span class="macro-label">Protein</span>
                <span class="macro-value">${Math.round(totals.protein)}g / ${goals.proteinG}g</span>
              </div>
              <div class="macro-track">
                <div class="macro-fill protein" style="width: ${Math.min(100, (totals.protein / goals.proteinG) * 100)}%"></div>
              </div>
            </div>
            <div class="macro-bar" role="progressbar" aria-valuenow="${Math.round(totals.carbs)}" aria-valuemax="${goals.carbG}" aria-label="Carbs progress">
              <div class="macro-header">
                <span class="macro-label">Carbs</span>
                <span class="macro-value">${Math.round(totals.carbs)}g / ${goals.carbG}g</span>
              </div>
              <div class="macro-track">
                <div class="macro-fill carbs" style="width: ${Math.min(100, (totals.carbs / goals.carbG) * 100)}%"></div>
              </div>
            </div>
            <div class="macro-bar" role="progressbar" aria-valuenow="${Math.round(totals.fat)}" aria-valuemax="${goals.fatG}" aria-label="Fat progress">
              <div class="macro-header">
                <span class="macro-label">Fat</span>
                <span class="macro-value">${Math.round(totals.fat)}g / ${goals.fatG}g</span>
              </div>
              <div class="macro-track">
                <div class="macro-fill fat" style="width: ${Math.min(100, (totals.fat / goals.fatG) * 100)}%"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Collapsible Micronutrients -->
        <details class="micro-details">
          <summary class="micro-summary">
            <span>Micronutrients</span>
            <svg class="micro-chevron" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <div class="micro-grid">
            <div class="micro-item">
              <span class="micro-label">Fiber</span>
              <span class="micro-value">${totals.fiber}g / ${goals.fiberG || 30}g</span>
            </div>
            <div class="micro-item">
              <span class="micro-label">Sodium</span>
              <span class="micro-value">${totals.sodium}mg / ${goals.sodiumMg || 2300}mg</span>
            </div>
          </div>
        </details>

        <!-- Remaining Calories -->
        <div class="remaining-calories">
          <span class="remaining-label">Remaining:</span>
          <span class="remaining-value">${caloriesRemaining} kcal</span>
        </div>

        <!-- Recent Meals Carousel -->
        ${recentFoods.length > 0 ? `
        <div class="recent-carousel" role="region" aria-label="Quick re-log recent foods">
          <h3 class="carousel-title">Quick Re-log</h3>
          <div class="carousel-scroll">
            ${recentFoods.map(food => {
              const kcal = food.nutrients?.energy?.kcal || 0;
              return `
                <button class="carousel-chip" data-food-id="${food.id}" aria-label="Re-log ${escapeHTML(food.name)}">
                  <span class="chip-name">${escapeHTML(food.name)}</span>
                  <span class="chip-kcal">${Math.round(kcal)} kcal</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
        ` : ''}

        <!-- Meal Sections -->
        <div class="meals-container" role="list" aria-label="Meals">
          ${mealSections.map(mealType => renderMealSection(mealType, mealsByType[mealType] || [], foodsMap)).join('')}
        </div>

        <!-- Daily Notes -->
        <div class="daily-notes" role="region" aria-label="Daily notes">
          <label class="notes-label" for="daily-note-input">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Daily Notes
          </label>
          <textarea
            class="daily-note-input"
            id="daily-note-input"
            placeholder="How are you feeling today? Any notes about your meals..."
            rows="2"
            aria-label="Daily notes for ${formatDate(currentDate)}"
          >${escapeHTML(dailyNote)}</textarea>
        </div>

        <!-- Quick Actions -->
        <div class="diary-actions">
          <button class="btn btn-ghost btn-small" id="copy-day-btn" aria-label="Copy meals from another day">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy Day
          </button>
          <button class="btn btn-ghost btn-small" id="save-template-btn" aria-label="Save today as meal template">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
            Save Template
          </button>
          <button class="btn btn-ghost btn-small" id="load-template-btn" aria-label="Load a saved meal template">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Load Template
          </button>
        </div>

        <!-- FAB Button -->
        <button class="fab" id="fab-add-food" aria-label="Quick add food">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>
        </button>
      </div>
    `;

    // Event listeners
    document.getElementById('prev-day').addEventListener('click', () => {
      currentDate = addDays(currentDate, -1);
      render();
    });

    document.getElementById('next-day').addEventListener('click', () => {
      currentDate = addDays(currentDate, 1);
      render();
    });

    document.getElementById('today-btn').addEventListener('click', () => {
      currentDate = todayStr();
      render();
    });

    document.getElementById('fab-add-food').addEventListener('click', () => {
      openMealTypePicker();
    });

    // Daily notes auto-save with debounce
    let noteTimeout;
    document.getElementById('daily-note-input')?.addEventListener('input', (e) => {
      clearTimeout(noteTimeout);
      noteTimeout = setTimeout(async () => {
        await setSetting(`note_${currentDate}`, e.target.value);
      }, 500);
    });

    // Recent meals carousel click handlers
    document.querySelectorAll('.carousel-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const foodId = chip.dataset.foodId;
        const food = await getById('foods', foodId);
        if (food) {
          // Navigate to search with pre-selected meal type
          window.location.hash = `#/search?meal=${getMealTypeForTime()}&foodId=${foodId}`;
        }
      });
    });

    // Day copy
    document.getElementById('copy-day-btn')?.addEventListener('click', () => openCopyDayModal(currentDate, render));

    // Save as template
    document.getElementById('save-template-btn')?.addEventListener('click', async () => {
      if (meals.length === 0) { showToast('No meals to save as template'); return; }
      const modal = document.createElement('div');
      modal.className = 'modal-content';
      modal.innerHTML = `
        <div class="modal-header"><h2>Save Meal Template</h2><button class="modal-close" id="modal-close" aria-label="Close">✕</button></div>
        <label class="control-group"><span class="control-label">Template Name</span>
          <input type="text" id="template-name" class="form-input" placeholder="e.g., My typical Monday" aria-label="Template name"></label>
        <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button><button class="btn btn-primary" id="save-btn">Save</button></div>
      `;
      openModal(modal);
      document.getElementById('modal-close').addEventListener('click', closeModal);
      document.getElementById('cancel-btn').addEventListener('click', closeModal);
      document.getElementById('save-btn').addEventListener('click', async () => {
        const name = document.getElementById('template-name').value.trim();
        if (!name) { showToast('Please enter a template name'); return; }
        const templateItems = meals.flatMap(m => (m.items || []).map(item => ({ ...item, mealType: m.type })));
        await put('settings', { key: `template_${generateId()}`, value: { name, items: templateItems, createdAt: new Date().toISOString() }, updatedAt: new Date().toISOString() });
        showToast('Template saved');
        closeModal();
      });
    });

    // Load template
    document.getElementById('load-template-btn')?.addEventListener('click', () => openLoadTemplateModal(currentDate, render));

    // Meal section add food buttons
    document.querySelectorAll('.meal-add-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mealType = e.currentTarget.dataset.mealType;
        window.location.hash = `#/search?meal=${mealType.toLowerCase()}`;
      });
    });

    // Food item click and keyboard handlers
    document.querySelectorAll('.food-item').forEach(el => {
      const handler = async () => {
        const mealId = el.dataset.mealId;
        const foodIndex = el.dataset.foodIndex;
        const meals = await getByIndex('meals', 'date', currentDate);
        const meal = meals.find(m => m.id === mealId);
        if (meal && meal.items[foodIndex]) {
          openPortionEditor(meal, foodIndex, currentDate, render);
        }
      };
      el.addEventListener('click', handler);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handler();
        }
      });
    });
  }

  render();
}

function createNutritionRing(consumed, target) {
  const radius = 52;
  const strokeWidth = 8;
  const circumference = 2 * Math.PI * radius;
  const percent = Math.min(consumed / target, 1);
  const dashoffset = circumference * (1 - percent);

  return `
    <svg class="nutrition-ring" width="120" height="120" viewBox="0 0 120 120">
      <circle
        cx="60"
        cy="60"
        r="${radius}"
        fill="none"
        stroke="currentColor"
        stroke-width="${strokeWidth}"
        opacity="0.2"
      />
      <circle
        class="ring-fill"
        cx="60"
        cy="60"
        r="${radius}"
        fill="none"
        stroke="currentColor"
        stroke-width="${strokeWidth}"
        stroke-dasharray="${circumference}"
        stroke-dashoffset="${dashoffset}"
        stroke-linecap="round"
        transform="rotate(-90 60 60)"
        style="
          --percent: ${percent};
          transition: stroke-dashoffset 0.3s ease;
          ${percent < 0.5 ? 'color: var(--color-warning);' : 'color: var(--color-success);'}
        "
      />
    </svg>
  `;
}

function groupMealsByType(meals) {
  const grouped = {
    Breakfast: [],
    Lunch: [],
    Dinner: [],
    Snacks: [],
  };

  meals.forEach(meal => {
    const type = meal.type.charAt(0).toUpperCase() + meal.type.slice(1);
    if (grouped[type]) {
      grouped[type].push(meal);
    }
  });

  return grouped;
}

function renderMealSection(mealType, mealsOfType, foodsMap) {
  const isMealsOfTypeEmpty = mealsOfType.length === 0 || mealsOfType.every(m => !m.items || m.items.length === 0);

  return `
    <section class="meal-section" data-meal-type="${mealType.toLowerCase()}" role="listitem" aria-label="${mealType} meals">
      <h3 class="meal-section-title">${mealType}</h3>
      <div class="meal-section-content">
        ${mealsOfType.map((meal, mealIdx) => `
          <div class="meal-group" data-meal-id="${meal.id}">
            ${(meal.items || []).map((item, foodIdx) => {
              const food = foodsMap.get(item.foodId);
              const kcal = item.nutrients?.kcal || 0;
              const name = food?.name || item.foodId || 'Unknown food';
              const unit = item.unit || food?.servingSize?.unit || 'g';
              return `
                <div class="food-item" data-meal-id="${meal.id}" data-food-index="${foodIdx}" role="button" tabindex="0" aria-label="${escapeHTML(name)}, ${item.quantity}${unit}, ${Math.round(kcal)} calories. Click to edit.">
                  <div class="food-info">
                    <div class="food-name">${escapeHTML(name)}</div>
                    <div class="food-portion">${item.quantity}${unit}</div>
                  </div>
                  <div class="food-calories">${Math.round(kcal)} kcal</div>
                </div>
              `;
            }).join('')}
          </div>
        `).join('')}
        ${isMealsOfTypeEmpty ? `
          <div class="meal-empty">
            <p>No meals logged</p>
          </div>
        ` : ''}
        <button class="meal-add-btn" data-meal-type="${mealType.toLowerCase()}" aria-label="Add food to ${mealType}">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          Add ${mealType}
        </button>
      </div>
    </section>
  `;
}

async function openPortionEditor(meal, foodIndex, currentDate, onComplete) {
  const item = meal.items[foodIndex];
  const food = await getById('foods', item.foodId);

  if (!food) return;

  const baseNutrition = {
    calories: food.nutrients?.energy?.kcal || 0,
    protein: food.nutrients?.macros?.protein?.g || 0,
    carbs: food.nutrients?.macros?.carbs?.g || 0,
    fat: food.nutrients?.macros?.fat?.g || 0,
  };

  let quantity = item.quantity || 100;
  let unit = item.unit || food.servingSize?.unit || 'g';

  const availableUnits = getUnitsForFood(food);

  function updatePreview() {
    const multiplier = getNutritionMultiplier(quantity, unit, food);
    const preview = document.getElementById('nutrition-preview');
    if (preview) {
      preview.innerHTML = `
        <div class="nutrition-preview">
          <div class="preview-stat">
            <span class="preview-label">Calories</span>
            <span class="preview-value">${Math.round(baseNutrition.calories * multiplier)} kcal</span>
          </div>
          <div class="preview-stat">
            <span class="preview-label">Protein</span>
            <span class="preview-value">${Math.round(baseNutrition.protein * multiplier)}g</span>
          </div>
          <div class="preview-stat">
            <span class="preview-label">Carbs</span>
            <span class="preview-value">${Math.round(baseNutrition.carbs * multiplier)}g</span>
          </div>
          <div class="preview-stat">
            <span class="preview-label">Fat</span>
            <span class="preview-value">${Math.round(baseNutrition.fat * multiplier)}g</span>
          </div>
        </div>
      `;
    }
  }

  const modal = document.createElement('div');
  modal.className = 'modal-content portion-editor';
  modal.innerHTML = `
    <div class="modal-header">
      <h2>${escapeHTML(food.name)}</h2>
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
          ${availableUnits.map(u => `
            <option value="${u.value}" ${u.value === unit ? 'selected' : ''}>${u.label}</option>
          `).join('')}
        </select>
      </label>
    </div>

    <div id="nutrition-preview"></div>

    <label class="control-group">
      <span class="control-label">Notes (optional)</span>
      <input type="text" class="notes-input" id="notes-input" value="${escapeHTML(item.notes || '')}">
    </label>

    <div class="modal-actions">
      <button class="btn btn-delete" id="delete-btn">Delete</button>
      <button class="btn btn-primary" id="save-btn">Update</button>
    </div>
  `;

  openModal(modal);

  const qtyInput = document.getElementById('qty-input');
  const unitSelect = document.getElementById('unit-select');
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

  unitSelect.addEventListener('change', (e) => {
    unit = e.target.value;
    updatePreview();
  });

  document.getElementById('modal-close').addEventListener('click', closeModal);

  document.getElementById('save-btn').addEventListener('click', async () => {
    item.quantity = quantity;
    item.unit = unit;
    item.notes = notesInput.value;
    await put('meals', meal);
    showToast('Food updated');
    closeModal();
    if (onComplete) onComplete();
  });

  document.getElementById('delete-btn').addEventListener('click', async () => {
    meal.items.splice(foodIndex, 1);
    if (meal.items.length === 0) {
      await softDelete('meals', meal.id);
    } else {
      await put('meals', meal);
    }
    showToast('Food removed');
    closeModal();
    if (onComplete) onComplete();
  });

  updatePreview();
}

function openMealTypePicker() {
  const modal = document.createElement('div');
  modal.className = 'modal-content';
  modal.innerHTML = `
    <div class="modal-header"><h2>Add Food To...</h2><button class="modal-close" id="modal-close" aria-label="Close">✕</button></div>
    <div class="meal-picker">
      <button class="meal-picker-btn" data-meal="breakfast" aria-label="Add to Breakfast">
        <span class="meal-picker-icon">🌅</span><span>Breakfast</span>
      </button>
      <button class="meal-picker-btn" data-meal="lunch" aria-label="Add to Lunch">
        <span class="meal-picker-icon">☀️</span><span>Lunch</span>
      </button>
      <button class="meal-picker-btn" data-meal="dinner" aria-label="Add to Dinner">
        <span class="meal-picker-icon">🌙</span><span>Dinner</span>
      </button>
      <button class="meal-picker-btn" data-meal="snacks" aria-label="Add to Snacks">
        <span class="meal-picker-icon">🍎</span><span>Snacks</span>
      </button>
    </div>
  `;
  openModal(modal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.querySelectorAll('.meal-picker-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const meal = btn.dataset.meal;
      closeModal();
      window.location.hash = `#/search?meal=${meal}`;
    });
  });
}

function getMealTypeForTime() {
  const hour = new Date().getHours();
  if (hour < 12) return 'breakfast';
  if (hour < 17) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snacks';
}

async function openCopyDayModal(targetDate, onComplete) {
  const yesterday = addDays(targetDate, -1);
  const modal = document.createElement('div');
  modal.className = 'modal-content';
  modal.innerHTML = `
    <div class="modal-header"><h2>Copy Meals From...</h2><button class="modal-close" id="modal-close" aria-label="Close">✕</button></div>
    <label class="control-group"><span class="control-label">Source Date</span>
      <input type="date" id="copy-source-date" class="form-input" value="${yesterday}" aria-label="Date to copy from"></label>
    <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button><button class="btn btn-primary" id="copy-btn">Copy Meals</button></div>
  `;
  openModal(modal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('copy-btn').addEventListener('click', async () => {
    const sourceDate = document.getElementById('copy-source-date').value;
    if (!sourceDate) { showToast('Please select a date'); return; }
    const sourceMeals = await getByIndex('meals', 'date', sourceDate) || [];
    if (sourceMeals.length === 0) { showToast('No meals found on that date'); return; }
    let count = 0;
    for (const meal of sourceMeals) {
      if (!meal.items || meal.items.length === 0) continue;
      const newMeal = {
        id: generateId(),
        date: targetDate,
        type: meal.type,
        items: meal.items.map(item => ({ ...item })),
        createdAt: new Date().toISOString(),
      };
      await put('meals', newMeal);
      count += meal.items.length;
    }
    showToast(`Copied ${count} food items`);
    closeModal();
    onComplete();
  });
}

async function openLoadTemplateModal(targetDate, onComplete) {
  // Get all templates from settings
  const allSettings = await getAll('settings');
  const templates = allSettings
    .filter(s => s.key?.startsWith('template_') && s.value?.name)
    .map(s => ({ key: s.key, ...s.value }));

  if (templates.length === 0) {
    showToast('No saved templates. Save one from the diary first.');
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'modal-content';
  modal.innerHTML = `
    <div class="modal-header"><h2>Load Meal Template</h2><button class="modal-close" id="modal-close" aria-label="Close">✕</button></div>
    <div class="template-list">
      ${templates.map((t, i) => `
        <div class="template-item" data-idx="${i}" role="button" tabindex="0">
          <span class="template-name">${escapeHTML(t.name)}</span>
          <span class="template-meta">${t.items?.length || 0} items</span>
        </div>
      `).join('')}
    </div>
    <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button></div>
  `;
  openModal(modal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);

  document.querySelectorAll('.template-item').forEach(el => {
    const handler = async () => {
      const idx = parseInt(el.dataset.idx);
      const template = templates[idx];
      if (!template?.items) return;
      // Group items by meal type
      const byType = {};
      for (const item of template.items) {
        const type = item.mealType || 'lunch';
        if (!byType[type]) byType[type] = [];
        byType[type].push(item);
      }
      for (const [type, items] of Object.entries(byType)) {
        await put('meals', {
          id: generateId(),
          date: targetDate,
          type,
          items: items.map(({ mealType, ...rest }) => ({ ...rest })),
          createdAt: new Date().toISOString(),
        });
      }
      showToast(`Template "${template.name}" loaded`);
      closeModal();
      onComplete();
    };
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
  });
}
