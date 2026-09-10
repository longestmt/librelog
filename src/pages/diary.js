import {
  deleteSetting,
  getById,
  getByIndex,
  getAll,
  getSetting,
  setSetting,
} from '../data/db.js';
import {
  copyMealsToDate,
  createIdempotencyKey,
  createMealBatch,
  removeMealItem,
  restoreMealItem,
  updateMealItem,
} from '../data/meal-commands.js';
import { getGoals } from '../engine/goal-tracking.js';
import { calculateDayTotalsSimple, scaleNutrients } from '../engine/nutrition.js';
import { todayStr, formatDate, addCalendarDays } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast, showUndoToast } from '../components/toast.js';
import { getUnitsForFood, getNutritionMultiplierOrNull } from '../utils/units.js';
import { getRecentFoods } from '../engine/food-search.js';
import { readPositiveNumberInput } from '../utils/form-validation.js';
import { captureDataMutationGeneration } from '../data/operation-locks.js';
import { assignNewItemIds, newId } from '../data/identity.js';
import { captureLibreLogEntityContext } from '../sync/entity-context.js';

function generateId() {
  return newId();
}

export async function renderDiaryPage(container, queryString) {
  const params = new URLSearchParams(queryString);
  const dateParam = params.get('date');
  let currentDate = isCalendarDate(dateParam) ? dateParam : todayStr();
  let noteTimeout = null;

  async function render() {
    const renderMutationGeneration = captureDataMutationGeneration();
    const meals = await getByIndex('meals', 'date', currentDate) || [];
    const goals = await getGoals();
    const noteKey = `note_${currentDate}`;
    // Context is captured before the value read so a remote update racing this
    // render cannot be silently treated as something the user already saw.
    let displayedNoteContext = await captureLibreLogEntityContext('settings', noteKey);
    const dailyNote = await getSetting(noteKey) || '';
    let noteSaveChain = Promise.resolve();

    const totals = calculateDayTotalsSimple(meals);
    const isIncomplete = key => totals.incomplete?.includes(key);
    const caloriesRemaining = goals.calorieTarget - totals.kcal;

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
      <div class="diary-page">
        <h1 class="sr-only">Daily food diary</h1>
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
              <div class="ring-main">${isIncomplete('kcal') ? `${totals.kcal}+` : totals.kcal}</div>
              <div class="ring-sub">${isIncomplete('kcal') ? 'known kcal' : `of ${goals.calorieTarget}`}</div>
            </div>
          </div>
          <div class="macro-bars">
            ${renderMacroGoal('Protein', 'protein', totals.protein, goals.proteinG, isIncomplete('protein'))}
            ${renderMacroGoal('Carbs', 'carbs', totals.carbs, goals.carbG, isIncomplete('carbs'))}
            ${renderMacroGoal('Fat', 'fat', totals.fat, goals.fatG, isIncomplete('fat'))}
          </div>
        </div>
        ${totals.incomplete?.length ? `<p class="nutrition-incomplete-notice" role="note"><strong>Partial nutrition:</strong> some foods do not include ${totals.incomplete.map(escapeHTML).join(', ')}. Known values are marked “+”; missing values are never counted as zero.</p>` : ''}

        <!-- Collapsible Micronutrients -->
        <details class="micro-details">
          <summary class="micro-summary">
            <span>Micronutrients</span>
            <svg class="micro-chevron" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <div class="micro-grid">
            <div class="micro-item">
              <span class="micro-label">Fiber</span>
              <span class="micro-value">${formatGoalTotal(totals.fiber, goals.fiberG, 'g', isIncomplete('fiber'))}</span>
            </div>
            <div class="micro-item">
              <span class="micro-label">Sodium</span>
              <span class="micro-value">${formatGoalTotal(totals.sodium, goals.sodiumMg, 'mg', isIncomplete('sodium'))}</span>
            </div>
          </div>
          ${totals.incomplete?.length ? `<p class="field-hint">Some logged foods do not include ${totals.incomplete.join(', ')}; totals omit those missing values.</p>` : ''}
        </details>

        <!-- Remaining Calories -->
        <div class="remaining-calories">
          <span class="remaining-label">${isIncomplete('kcal') ? 'Remaining:' : caloriesRemaining >= 0 ? 'Remaining:' : 'Above target:'}</span>
          <span class="remaining-value">${isIncomplete('kcal') ? 'Unknown' : `${Math.abs(caloriesRemaining)} kcal`}</span>
        </div>

        <!-- Recent Meals Carousel -->
        ${recentFoods.length > 0 ? `
        <div class="recent-carousel" role="region" aria-label="Quick re-log recent foods">
          <h3 class="carousel-title">Quick Re-log</h3>
          <div class="carousel-scroll">
            ${recentFoods.map(food => {
              const kcal = food.nutrients?.energy?.kcal;
              return `
                <button class="carousel-chip" data-food-id="${escapeHTML(String(food.id))}" aria-label="Re-log ${escapeHTML(food.name)}">
                  <span class="chip-name">${escapeHTML(food.name)}</span>
                  <span class="chip-kcal">${kcal != null && Number.isFinite(Number(kcal)) ? `${Math.round(Number(kcal))} kcal` : 'Calories unknown'}</span>
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
            maxlength="2000"
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
          <button class="btn btn-ghost btn-small" id="meal-history-btn" aria-label="Search meal history">
            Meal History
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
      window.location.hash = `#/diary?date=${addCalendarDays(currentDate, -1)}`;
    });

    document.getElementById('next-day').addEventListener('click', () => {
      window.location.hash = `#/diary?date=${addCalendarDays(currentDate, 1)}`;
    });

    document.getElementById('today-btn').addEventListener('click', () => {
      window.location.hash = `#/diary?date=${todayStr()}`;
    });

    document.getElementById('fab-add-food').addEventListener('click', () => {
      openMealTypePicker(currentDate);
    });

    // Daily notes auto-save with debounce
    document.getElementById('daily-note-input')?.addEventListener('input', (e) => {
      clearTimeout(noteTimeout);
      const value = e.target.value;
      const mutationGeneration = captureDataMutationGeneration();
      noteTimeout = setTimeout(() => {
        noteTimeout = null;
        if (!container.isConnected) return;
        noteSaveChain = noteSaveChain.then(async () => {
          const context = structuredClone(displayedNoteContext);
          if (value === '') {
            await deleteSetting(noteKey, { context, mutationGeneration });
          } else {
            await setSetting(noteKey, value, { context, mutationGeneration });
          }

          // Refresh in context-before-value order. Adopt the new context only
          // when the materialized value matches what this editor saved; a
          // differing remote value remains an explicit conflict on the next
          // local edit.
          const refreshedContext = await captureLibreLogEntityContext('settings', noteKey);
          const materializedNote = await getSetting(noteKey, '');
          if (materializedNote === value) displayedNoteContext = refreshedContext;
        }).catch(error => {
          if (error?.code !== 'DATA_OPERATION_INVALIDATED') {
            console.warn('Could not save daily note:', error);
          }
        });
      }, 500);
    });

    // Recent meals carousel click handlers
    document.querySelectorAll('.carousel-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const foodId = chip.dataset.foodId;
        const food = await getById('foods', foodId);
        if (food) {
          // Navigate to search with pre-selected meal type
          window.location.hash = `#/search?meal=${getMealTypeForTime()}&foodId=${encodeURIComponent(foodId)}&date=${currentDate}`;
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
          <input type="text" id="template-name" class="form-input" maxlength="120" placeholder="e.g., My typical Monday" aria-label="Template name"></label>
        <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button><button class="btn btn-primary" id="save-btn">Save</button></div>
      `;
      let templateSaveInProgress = false;
      const templateKey = `template_${generateId()}`;
      const dialog = openModal(modal, { canClose: () => !templateSaveInProgress });
      const modalControls = [...dialog.querySelectorAll('button, input, select')];
      const saveButton = dialog.querySelector('#save-btn');
      dialog.querySelector('#modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
      dialog.querySelector('#cancel-btn').addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
      saveButton.addEventListener('click', async () => {
        if (templateSaveInProgress) return;
        const name = dialog.querySelector('#template-name').value.trim();
        if (!name) { showToast('Please enter a template name'); return; }
        const templateItems = assignNewItemIds(meals.flatMap(m => (m.items || []).map(
          ({ itemId, ...item }) => ({ ...item, mealType: m.type }),
        )));
        templateSaveInProgress = true;
        modalControls.forEach(control => { control.disabled = true; });
        saveButton.textContent = 'Saving…';
        try {
          await setSetting(templateKey, {
            kind: 'day',
            name,
            items: templateItems,
            createdAt: new Date().toISOString(),
          }, { mutationGeneration: renderMutationGeneration });
          showToast('Template saved');
          closeModal({ target: dialog, force: true, reason: 'completed' });
        } catch (error) {
          console.error('Template save failed:', error);
          showToast('Template could not be saved', 'error');
          templateSaveInProgress = false;
          modalControls.forEach(control => { control.disabled = false; });
          saveButton.textContent = 'Save';
        }
      });
    });

    // Load template
    document.getElementById('load-template-btn')?.addEventListener('click', () => openLoadTemplateModal(currentDate, render));
    document.getElementById('meal-history-btn')?.addEventListener('click', () => {
      window.location.hash = `#/history?date=${currentDate}`;
    });

    // Meal section add food buttons
    document.querySelectorAll('.meal-add-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mealType = e.currentTarget.dataset.mealType;
        window.location.hash = `#/search?meal=${mealType.toLowerCase()}&date=${currentDate}`;
      });
    });

    // Food item click and keyboard handlers
    document.querySelectorAll('.food-item').forEach(el => {
      const handler = async () => {
        const mutationGeneration = captureDataMutationGeneration();
        const mealId = el.dataset.mealId;
        const itemId = el.dataset.itemId;
        const displayedContext = await captureLibreLogEntityContext('meals', mealId);
        const meals = await getByIndex('meals', 'date', currentDate);
        const meal = meals.find(m => m.id === mealId);
        if (meal?.items?.some(item => item.itemId === itemId)) {
          openPortionEditor(
            meal,
            itemId,
            currentDate,
            render,
            mutationGeneration,
            displayedContext,
          );
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

  await render();
  return () => {
    clearTimeout(noteTimeout);
    noteTimeout = null;
  };
}

function hasEnabledGoal(target) {
  return Number.isFinite(Number(target)) && Number(target) > 0;
}

function formatGoalTotal(value, target, unit, incomplete) {
  const displayedValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  const knownValue = `${displayedValue}${unit}${incomplete ? '+ known' : ''}`;
  return hasEnabledGoal(target)
    ? (incomplete ? knownValue : `${knownValue} / ${target}${unit}`)
    : `${knownValue} · no target`;
}

function renderMacroGoal(label, key, value, target, incomplete) {
  const displayedValue = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  const enabled = hasEnabledGoal(target);
  const percentage = enabled
    ? Math.min(100, Math.max(0, (displayedValue / Number(target)) * 100))
    : 0;
  const accessibility = enabled
    ? `role="progressbar" aria-valuenow="${displayedValue}" aria-valuemax="${target}" aria-label="${incomplete ? `${label} total is partial; known progress` : `${label} progress`}"`
    : `role="group" aria-label="${label} ${incomplete ? 'known ' : ''}total; no target"`;

  return `
    <div class="macro-bar" ${accessibility}>
      <div class="macro-header">
        <span class="macro-label">${label}</span>
        <span class="macro-value">${formatGoalTotal(displayedValue, target, 'g', incomplete)}</span>
      </div>
      <div class="macro-track">
        <div class="macro-fill ${key}" style="width: ${percentage}%"></div>
      </div>
    </div>
  `;
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
          <div class="meal-group" data-meal-id="${escapeHTML(String(meal.id))}">
            ${(meal.items || []).map(item => {
              const food = foodsMap.get(item.foodId);
              const kcal = item.nutrients?.kcal;
              const calorieDisplay = kcal != null && Number.isFinite(Number(kcal)) ? `${Math.round(Number(kcal))} kcal` : 'Calories unknown';
              const accessibleCalories = kcal != null && Number.isFinite(Number(kcal)) ? `${Math.round(Number(kcal))} calories` : 'calories unknown';
              const name = item.nameSnapshot || food?.name || item.foodId || 'Unknown food';
              const unit = item.unit || food?.servingSize?.unit || 'g';
              const portion = `${item.quantity} ${unit}`;
              const servingReference = item.basisSnapshot?.label;
              const portionDisplay = servingReference && servingReference !== portion
                ? `${portion} · ${servingReference}`
                : portion;
              const sourceType = typeof food?.source?.type === 'string' ? food.source.type : '';
              const sourceLabel = item.provenance?.nutritionSource
                || (sourceType.startsWith('ai-') ? 'AI estimate' : '');
              return `
                <div class="food-item" data-meal-id="${escapeHTML(String(meal.id))}" data-item-id="${escapeHTML(String(item.itemId))}" role="button" tabindex="0" aria-label="${escapeHTML(name)}, ${escapeHTML(portionDisplay)}, ${escapeHTML(accessibleCalories)}. Click to edit.">
                  <div class="food-info">
                    <div class="food-name">${escapeHTML(name)}${sourceLabel ? ` <span class="source-badge ${sourceLabel === 'AI estimate' ? 'ai' : ''}">${escapeHTML(sourceLabel)}</span>` : ''}</div>
                    <div class="food-portion">${escapeHTML(portionDisplay)}</div>
                  </div>
                  <div class="food-calories">${escapeHTML(calorieDisplay)}</div>
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

async function openPortionEditor(
  meal,
  itemId,
  currentDate,
  onComplete,
  mutationGeneration,
  displayedContext,
) {
  const item = meal.items.find(candidate => candidate.itemId === itemId);
  if (!item) return;
  const food = await getById('foods', item.foodId);
  const basis = item.basisSnapshot;
  const nutritionFood = basis ? {
    ...(food || {}),
    name: item.nameSnapshot || food?.name || 'Logged food',
    servingSize: {
      quantity: basis.quantity,
      unit: basis.unit,
      gramsPerUnit: basis.gramsPerUnit,
      aliases: basis.aliases || [],
      label: basis.label || null,
      packageQuantity: basis.packageQuantity,
      packageUnit: basis.packageUnit,
    },
    nutrients: {
      energy: { kcal: basis.nutrients?.kcal },
      macros: {
        protein: { g: basis.nutrients?.protein },
        carbs: { g: basis.nutrients?.carbs },
        fat: { g: basis.nutrients?.fat },
      },
      fiber: { g: basis.nutrients?.fiber },
      sodium: { mg: basis.nutrients?.sodium },
    },
  } : food;

  if (!nutritionFood) return;

  const numberOrNull = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  const baseNutrition = {
    calories: numberOrNull(nutritionFood.nutrients?.energy?.kcal),
    protein: numberOrNull(nutritionFood.nutrients?.macros?.protein?.g),
    carbs: numberOrNull(nutritionFood.nutrients?.macros?.carbs?.g),
    fat: numberOrNull(nutritionFood.nutrients?.macros?.fat?.g),
  };

  let quantity = item.quantity ?? nutritionFood.servingSize?.quantity ?? 100;
  let unit = item.unit || nutritionFood.servingSize?.unit || 'g';

  const availableUnits = getUnitsForFood(nutritionFood);
  if (!availableUnits.some(candidate => candidate.value === unit)) {
    availableUnits.unshift({ value: unit, label: unit });
  }

  function updatePreview() {
    const multiplier = getNutritionMultiplierOrNull(quantity, unit, nutritionFood);
    const display = (value, suffix, precision = 0) => Number.isFinite(value) && multiplier != null
      ? `${(value * multiplier).toFixed(precision)}${suffix}`
      : 'Unknown';
    const preview = dialog?.querySelector('#nutrition-preview');
    if (preview) {
      preview.innerHTML = `
        <div class="nutrition-preview">
          <div class="preview-stat">
            <span class="preview-label">Calories</span>
            <span class="preview-value">${display(baseNutrition.calories, ' kcal')}</span>
          </div>
          <div class="preview-stat">
            <span class="preview-label">Protein</span>
            <span class="preview-value">${display(baseNutrition.protein, 'g', 1)}</span>
          </div>
          <div class="preview-stat">
            <span class="preview-label">Carbs</span>
            <span class="preview-value">${display(baseNutrition.carbs, 'g', 1)}</span>
          </div>
          <div class="preview-stat">
            <span class="preview-label">Fat</span>
            <span class="preview-value">${display(baseNutrition.fat, 'g', 1)}</span>
          </div>
        </div>
      `;
    }
  }

  const modal = document.createElement('div');
  modal.className = 'modal-content portion-editor';
  modal.innerHTML = `
    <div class="modal-header">
      <h2>${escapeHTML(item.nameSnapshot || nutritionFood.name)}</h2>
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
            <option value="${escapeHTML(String(u.value))}" ${u.value === unit ? 'selected' : ''}>${escapeHTML(String(u.label))}</option>
          `).join('')}
        </select>
      </label>
    </div>

    ${basis?.label ? `<p class="serving-reference">Serving reference: ${escapeHTML(basis.label)}</p>` : ''}

    <div id="nutrition-preview"></div>

    <label class="control-group">
      <span class="control-label">Notes (optional)</span>
      <input type="text" class="notes-input" id="notes-input" maxlength="500" value="${escapeHTML(item.notes || '')}">
    </label>

    <div class="modal-actions">
      <button class="btn btn-delete" id="delete-btn">Delete</button>
      <button class="btn btn-primary" id="save-btn">Update</button>
    </div>
  `;

  const updateCommandKey = createIdempotencyKey('edit');
  const removeCommandKey = createIdempotencyKey('remove');
  const undoRemoveCommandKey = createIdempotencyKey('undo-remove');
  let actionInProgress = false;
  let deleteArmed = false;
  const dialog = openModal(modal, { canClose: () => !actionInProgress });

  const qtyInput = dialog.querySelector('#qty-input');
  const unitSelect = dialog.querySelector('#unit-select');
  const notesInput = dialog.querySelector('#notes-input');
  const saveButton = dialog.querySelector('#save-btn');
  const deleteButton = dialog.querySelector('#delete-btn');
  const modalControls = [...dialog.querySelectorAll('button, input, select')];

  dialog.querySelector('#qty-minus').addEventListener('click', () => {
    const current = readPositiveNumberInput(qtyInput, { report: true });
    if (current == null) return;
    quantity = Math.max(0.1, current - 0.5);
    qtyInput.value = quantity;
    updatePreview();
  });

  dialog.querySelector('#qty-plus').addEventListener('click', () => {
    const current = readPositiveNumberInput(qtyInput, { report: true });
    if (current == null) return;
    quantity = current + 0.5;
    qtyInput.value = quantity.toFixed(1);
    updatePreview();
  });

  qtyInput.addEventListener('change', () => {
    const next = readPositiveNumberInput(qtyInput, { report: true });
    quantity = next ?? NaN;
    updatePreview();
  });

  unitSelect.addEventListener('change', (e) => {
    unit = e.target.value;
    updatePreview();
  });

  dialog.querySelector('#modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));

  saveButton.addEventListener('click', async () => {
    if (actionInProgress) return;
    const nextQuantity = readPositiveNumberInput(qtyInput, { report: true });
    if (nextQuantity == null) return;
    quantity = nextQuantity;
    actionInProgress = true;
    modalControls.forEach(control => { control.disabled = true; });
    saveButton.textContent = 'Updating…';
    try {
      await updateMealItem(meal.id, itemId, {
        ...item,
        quantity,
        unit,
        notes: notesInput.value,
        nutrients: scaleNutrients(nutritionFood, quantity, unit),
      }, {
        context: displayedContext,
        idempotencyKey: updateCommandKey,
        mutationGeneration,
      });
      showToast('Food updated');
      closeModal({ target: dialog, force: true, reason: 'completed' });
      if (onComplete) await onComplete();
    } catch (error) {
      console.error('Food update failed:', error);
      showToast(error?.message?.includes('another tab')
        ? 'This food changed in another tab. Reopen it before editing.'
        : 'Could not update food.', 'error', 7000);
      actionInProgress = false;
      modalControls.forEach(control => { control.disabled = false; });
      saveButton.textContent = 'Update';
    }
  });

  deleteButton.addEventListener('click', async () => {
    if (actionInProgress) return;
    if (!deleteArmed) {
      deleteArmed = true;
      deleteButton.textContent = 'Confirm delete';
      deleteButton.setAttribute('aria-label', 'Confirm removal of this food');
      return;
    }
    actionInProgress = true;
    modalControls.forEach(control => { control.disabled = true; });
    deleteButton.textContent = 'Deleting…';
    try {
      const removal = await removeMealItem(meal.id, itemId, {
        context: displayedContext,
        idempotencyKey: removeCommandKey,
        mutationGeneration,
      });
      closeModal({ target: dialog, force: true, reason: 'completed' });
      if (onComplete) await onComplete();
      showUndoToast('Food removed', async () => {
        await restoreMealItem(meal.id, removal.removedIndex, removal.removedItem, {
          idempotencyKey: undoRemoveCommandKey,
          mutationGeneration,
        });
        showToast('Food restored');
        if (onComplete) await onComplete();
      });
    } catch (error) {
      console.error('Food removal failed:', error);
      showToast('Could not remove food');
      actionInProgress = false;
      modalControls.forEach(control => { control.disabled = false; });
      deleteButton.textContent = 'Confirm delete';
    }
  });

  updatePreview();
}

function openMealTypePicker(targetDate) {
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
      window.location.hash = `#/search?meal=${meal}&date=${targetDate}`;
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

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

async function openCopyDayModal(targetDate, onComplete) {
  const yesterday = addCalendarDays(targetDate, -1);
  const modal = document.createElement('div');
  modal.className = 'modal-content';
  modal.innerHTML = `
    <div class="modal-header"><h2>Copy Meals From...</h2><button class="modal-close" id="modal-close" aria-label="Close">✕</button></div>
    <label class="control-group"><span class="control-label">Source Date</span>
      <input type="date" id="copy-source-date" class="form-input" value="${yesterday}" aria-label="Date to copy from"></label>
    <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button><button class="btn btn-primary" id="copy-btn">Copy Meals</button></div>
  `;
  let copyInProgress = false;
  const dialog = openModal(modal, { canClose: () => !copyInProgress });
  const modalControls = [...dialog.querySelectorAll('button, input, select')];
  dialog.querySelector('#modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
  dialog.querySelector('#cancel-btn').addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
  const copyCommandKey = createIdempotencyKey('copy-day');
  dialog.querySelector('#copy-btn').addEventListener('click', async (event) => {
    if (copyInProgress) return;
    const button = event.currentTarget;
    const sourceDate = dialog.querySelector('#copy-source-date').value;
    if (!sourceDate) {
      showToast('Please select a date');
      return;
    }
    copyInProgress = true;
    modalControls.forEach(control => { control.disabled = true; });
    button.textContent = 'Copying…';
    try {
      const mutationGeneration = captureDataMutationGeneration();
      const sourceMeals = await getByIndex('meals', 'date', sourceDate) || [];
      if (sourceMeals.length === 0) {
        showToast('No meals found on that date');
        copyInProgress = false;
        modalControls.forEach(control => { control.disabled = false; });
        button.textContent = 'Copy Meals';
        return;
      }
      await copyMealsToDate(sourceMeals, targetDate, {
        idempotencyKey: copyCommandKey,
        mutationGeneration,
      });
      const count = sourceMeals.reduce((total, meal) => total + (meal.items?.length || 0), 0);
      showToast(`Copied ${count} food items`);
      closeModal({ target: dialog, force: true, reason: 'completed' });
      await onComplete();
    } catch (error) {
      console.error('Copy day failed:', error);
      showToast('Meals could not be copied. Nothing was added.', 'error');
      copyInProgress = false;
      modalControls.forEach(control => { control.disabled = false; });
      button.textContent = 'Copy Meals';
    }
  });
}

async function openLoadTemplateModal(targetDate, onComplete) {
  // Get all templates from settings
  const mutationGeneration = captureDataMutationGeneration();
  const allSettings = await getAll('settings');
  const templates = allSettings
    .filter(s => s.key?.startsWith('template_') && s.value?.name && s.value?.kind !== 'meal')
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
        <div class="template-item">
          <button class="btn btn-ghost template-load" data-idx="${i}">
            <span class="template-name">${escapeHTML(t.name)}</span>
            <span class="template-meta">${t.items?.length || 0} items</span>
          </button>
          <button class="btn btn-ghost btn-small template-delete" data-idx="${i}" aria-label="Delete ${escapeHTML(t.name)} template">Delete</button>
        </div>
      `).join('')}
    </div>
    <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button></div>
  `;
  let templateLoading = false;
  const dialog = openModal(modal, { canClose: () => !templateLoading });
  dialog.querySelector('#modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
  dialog.querySelector('#cancel-btn').addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));

  dialog.querySelectorAll('.template-load').forEach(el => {
    const templateCommandKey = createIdempotencyKey('template');
    const handler = async () => {
      if (templateLoading) return;
      const idx = parseInt(el.dataset.idx);
      const template = templates[idx];
      if (!template?.items) return;
      templateLoading = true;
      dialog.querySelectorAll('.template-item').forEach(item => item.setAttribute('aria-disabled', 'true'));
      // Group items by meal type
      const byType = {};
      for (const item of template.items) {
        const type = item.mealType || 'lunch';
        if (!byType[type]) byType[type] = [];
        byType[type].push(item);
      }
      try {
        await createMealBatch(
          Object.entries(byType).map(([type, items]) => ({
            date: targetDate,
            type,
            items: items.map(({ mealType, ...rest }) => ({ ...rest })),
          })),
          { idempotencyKey: templateCommandKey, mutationGeneration },
        );
        showToast(`Template "${template.name}" loaded`);
        closeModal({ target: dialog, force: true, reason: 'completed' });
        await onComplete();
      } catch (error) {
        console.error('Template load failed:', error);
        showToast('Template could not be loaded. Nothing was added.', 'error');
        templateLoading = false;
        dialog.querySelectorAll('.template-item').forEach(item => item.setAttribute('aria-disabled', 'false'));
      }
    };
    el.addEventListener('click', handler);
  });
  dialog.querySelectorAll('.template-delete').forEach(button => {
    button.addEventListener('click', async event => {
      if (templateLoading) return;
      const template = templates[Number(event.currentTarget.dataset.idx)];
      if (!template) return;
      templateLoading = true;
      try {
        const displayedContext = await captureLibreLogEntityContext('settings', template.key);
        const currentTemplate = await getSetting(template.key, null);
        if (!currentTemplate || !confirm(`Delete the template "${currentTemplate.name}"?`)) {
          templateLoading = false;
          return;
        }
        dialog.querySelectorAll('button').forEach(control => { control.disabled = true; });
        await deleteSetting(template.key, { context: displayedContext, mutationGeneration });
        showToast(`Template "${currentTemplate.name}" deleted`);
        closeModal({ target: dialog, force: true, reason: 'completed' });
        await onComplete();
      } catch (error) {
        console.error('Template delete failed:', error);
        showToast('Template could not be deleted', 'error');
        templateLoading = false;
        dialog.querySelectorAll('button').forEach(control => { control.disabled = false; });
      }
    });
  });
}
