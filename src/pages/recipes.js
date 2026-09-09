import { getAll, getById, put, softDelete } from '../data/db.js';
import { searchFoodsWithStatus } from '../engine/food-search.js';
import { grantRemoteProviderConsent } from '../integrations/privacy.js';
import { todayStr } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { getNutritionMultiplierOrNull, getUnitsForFood } from '../utils/units.js';
import {
  calculateRecipeNutrition,
  ensureRecipeItemSnapshot,
  getRecipeItemFood,
  scaleRecipeItemQuantity,
} from '../engine/recipes.js';
import { createIdempotencyKey, createMeal } from '../data/meal-commands.js';
import { createDraftItem, toMealItem } from '../data/add-draft.js';
import { readPositiveNumberInput } from '../utils/form-validation.js';
import { captureDataMutationGeneration } from '../data/operation-locks.js';

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export async function renderRecipesPage(container, queryString) {
  const params = new URLSearchParams(queryString);
  const recipeId = params.get('id');
  const isNew = params.get('new') === '1';

  if (recipeId || isNew) {
    await renderRecipeDetail(container, recipeId);
  } else {
    await renderRecipeList(container);
  }
}

/* ------------------------------------------------------------------ */
/*  Recipe List View                                                   */
/* ------------------------------------------------------------------ */

async function renderRecipeList(container) {
  const recipes = await getAll('recipes');

  container.innerHTML = `
    <div class="recipes-page">
      <div class="page-header">
        <h1 class="page-title">Recipes</h1>
      </div>

      ${recipes.length === 0 ? `
        <div class="empty-state" role="status">
          <p>No recipes yet. Create your first recipe!</p>
        </div>
      ` : `
        <div class="recipe-list" role="list" aria-label="Saved recipes">
          ${recipes.map(recipe => {
            const perServing = recipe.nutritionPerServing || {};
            const display = (key, suffix = '') => perServing.incomplete?.includes(key)
              || !Number.isFinite(Number(perServing[key]))
              ? `—${suffix}`
              : `${Math.round(Number(perServing[key]))}${suffix}`;
            const kcal = display('kcal');
            const protein = display('protein', 'P');
            const carbs = display('carbs', 'C');
            const fat = display('fat', 'F');
            return `
              <div class="recipe-card" data-recipe-id="${escapeHTML(String(recipe.id))}" role="listitem" tabindex="0"
                   aria-label="${escapeHTML(recipe.name)}, ${kcal === '—' ? 'calories unknown' : `${kcal} calories`} per serving">
                <div class="recipe-card-info">
                  <div class="recipe-card-name">${escapeHTML(recipe.name)}</div>
                  <div class="recipe-card-meta">
                    <span class="recipe-servings">${recipe.servings || 1} serving${(recipe.servings || 1) !== 1 ? 's' : ''}</span>
                    <span class="recipe-kcal">${kcal} kcal/serving</span>
                    <span class="macro-summary">${protein} ${carbs} ${fat}</span>
                  </div>
                  ${recipe.category ? `<span class="category-tag">${escapeHTML(recipe.category)}</span>` : ''}
                </div>
                <div class="recipe-card-action" aria-hidden="true">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}

      <button class="fab" id="new-recipe-btn" aria-label="Create new recipe">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>
      </button>
    </div>
  `;

  document.getElementById('new-recipe-btn').addEventListener('click', () => {
    window.location.hash = '#/recipes?new=1';
  });

  container.querySelectorAll('.recipe-card').forEach(card => {
    const handler = () => {
      const id = card.dataset.recipeId;
      window.location.hash = `#/recipes?id=${encodeURIComponent(id)}`;
    };
    card.addEventListener('click', handler);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handler();
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Recipe Detail / Edit View                                          */
/* ------------------------------------------------------------------ */

async function renderRecipeDetail(container, recipeId) {
  const mutationGeneration = captureDataMutationGeneration();
  let recipe = recipeId ? await getById('recipes', recipeId) : null;

  // Working state
  let name = recipe?.name || '';
  let servings = recipe?.servings || 1;
  let category = recipe?.category || '';
  let instructions = recipe?.instructions || '';
  let items = recipe?.items ? recipe.items.map(i => ({ ...i })) : [];
  let saveInProgress = false;
  let mealLogInProgress = false;

  // Resolve all foods for current ingredients
  const foodsMap = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const food = await getById('foods', item.foodId);
    if (!food) continue;
    foodsMap.set(item.foodId, food);
    if (!item.basisSnapshot) {
      items[index] = ensureRecipeItemSnapshot(item, food);
    }
  }

  // Keep derived legacy snapshots in working state until the user saves. A
  // passive page open must not overwrite a newer edit from another tab.

  function calcNutritionPerServing() {
    return calculateRecipeNutrition(items, foodsMap, servings);
  }

  function formatNutritionValue(perServing, key, suffix = '') {
    return perServing.incomplete.includes(key)
      ? '—'
      : `${Math.round(perServing[key])}${suffix}`;
  }

  function nutritionSummaryMarkup(perServing) {
    return `
      <div class="recipe-section nutrition-summary-section" role="region" aria-label="Per-serving nutrition">
        <h3 class="section-title">Per-Serving Nutrition</h3>
        <div class="nutrition-grid">
          <div class="nutrition-stat"><span class="nutrition-stat-value">${formatNutritionValue(perServing, 'kcal')}</span><span class="nutrition-stat-label">kcal</span></div>
          <div class="nutrition-stat"><span class="nutrition-stat-value">${formatNutritionValue(perServing, 'protein', 'g')}</span><span class="nutrition-stat-label">Protein</span></div>
          <div class="nutrition-stat"><span class="nutrition-stat-value">${formatNutritionValue(perServing, 'carbs', 'g')}</span><span class="nutrition-stat-label">Carbs</span></div>
          <div class="nutrition-stat"><span class="nutrition-stat-value">${formatNutritionValue(perServing, 'fat', 'g')}</span><span class="nutrition-stat-label">Fat</span></div>
          <div class="nutrition-stat"><span class="nutrition-stat-value">${formatNutritionValue(perServing, 'fiber', 'g')}</span><span class="nutrition-stat-label">Fiber</span></div>
        </div>
        ${perServing.incomplete.length > 0 ? `
          <details class="nutrition-data-note">
            <summary>Some nutrition data is unavailable</summary>
            <p>LibreLog does not count unknown ${perServing.incomplete.map(escapeHTML).join(', ')} values as zero.</p>
          </details>
        ` : ''}
      </div>
    `;
  }

  function render() {
    const perServing = calcNutritionPerServing();

    container.innerHTML = `
      <div class="recipes-page recipe-detail">
        <div class="page-header">
          <button class="btn btn-ghost" id="back-btn" aria-label="Back to recipes">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Back
          </button>
        </div>

        <div class="form-group">
          <label class="control-label" for="recipe-name">Recipe Name</label>
          <input type="text" id="recipe-name" class="form-input" maxlength="120" value="${escapeHTML(name)}" placeholder="e.g., Overnight Oats" required aria-required="true">
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="control-label" for="recipe-servings">Servings Yield</label>
            <input type="number" id="recipe-servings" class="form-input" value="${servings}" min="1" step="1" aria-label="Number of servings this recipe yields">
          </div>
          <div class="form-group">
            <label class="control-label" for="recipe-category">Category</label>
            <input type="text" id="recipe-category" class="form-input" maxlength="80" value="${escapeHTML(category)}" placeholder="e.g., Breakfast, Main, Snack">
          </div>
        </div>

        <!-- Ingredients -->
        <div class="recipe-section" role="region" aria-label="Ingredients">
          <h3 class="section-title">Ingredients</h3>
          ${items.length === 0 ? `
            <p class="empty-hint">No ingredients added yet.</p>
          ` : `
            <div class="ingredient-list" role="list" aria-label="Ingredient list">
              ${items.map((item, idx) => {
                const food = getRecipeItemFood(item, foodsMap);
                const foodName = item.nameSnapshot || food?.name || 'Unknown food';
                const multiplier = food
                  ? getNutritionMultiplierOrNull(item.quantity, item.unit, food)
                  : null;
                const kcalValue = food?.nutrients?.energy?.kcal;
                const kcal = kcalValue != null && Number.isFinite(Number(kcalValue)) && Number.isFinite(multiplier)
                  ? `${Math.round(Number(kcalValue) * multiplier)} kcal`
                  : 'Calories unknown';
                return `
                  <div class="ingredient-item" role="listitem">
                    <div class="ingredient-info">
                      <span class="ingredient-name">${escapeHTML(foodName)}</span>
                      <span class="ingredient-portion">${escapeHTML(String(item.quantity))} ${escapeHTML(String(item.unit))}</span>
                      <span class="ingredient-kcal">${kcal}</span>
                    </div>
                    <button class="btn btn-ghost btn-icon ingredient-remove" data-index="${idx}" aria-label="Remove ${escapeHTML(foodName)}">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                `;
              }).join('')}
            </div>
          `}
          <button class="btn btn-outline" id="add-ingredient-btn" aria-label="Add ingredient">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Add Ingredient
          </button>
        </div>

        <!-- Per-Serving Nutrition Summary -->
        ${nutritionSummaryMarkup(perServing)}

        <!-- Instructions -->
        <div class="form-group">
          <label class="control-label" for="recipe-instructions">Instructions (optional)</label>
          <textarea id="recipe-instructions" class="form-input form-textarea" rows="5" maxlength="10000" placeholder="Add preparation steps...">${escapeHTML(instructions)}</textarea>
        </div>

        <!-- Actions -->
        <div class="recipe-actions">
          <button class="btn btn-primary" id="save-recipe-btn">Save Recipe</button>
          ${recipe ? `<button class="btn btn-outline" id="log-meal-btn">Log as Meal</button>` : ''}
          ${recipe ? `<button class="btn btn-delete" id="delete-recipe-btn">Delete Recipe</button>` : ''}
        </div>
      </div>
    `;

    bindDetailEvents();
  }

  function syncFieldsFromDOM({ reportInvalid = false } = {}) {
    const nameInput = container.querySelector('#recipe-name');
    const servingsInput = container.querySelector('#recipe-servings');
    const categoryInput = container.querySelector('#recipe-category');
    const instructionsInput = container.querySelector('#recipe-instructions');
    if (nameInput) name = nameInput.value.trim();
    let valid = true;
    if (servingsInput) {
      const nextServings = readPositiveNumberInput(servingsInput, {
        report: reportInvalid,
        min: 1,
        integer: true,
      });
      if (nextServings == null) valid = false;
      else servings = nextServings;
    }
    if (categoryInput) category = categoryInput.value.trim();
    if (instructionsInput) instructions = instructionsInput.value;
    return valid;
  }

  function bindDetailEvents() {
    document.getElementById('back-btn').addEventListener('click', () => {
      window.location.hash = '#/recipes';
    });

    // Live-sync servings to update nutrition display
    document.getElementById('recipe-servings').addEventListener('change', () => {
      if (!syncFieldsFromDOM({ reportInvalid: true })) return;
      const summary = container.querySelector('.nutrition-summary-section');
      if (summary) summary.outerHTML = nutritionSummaryMarkup(calcNutritionPerServing());
    });

    // Remove ingredient buttons
    container.querySelectorAll('.ingredient-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!syncFieldsFromDOM({ reportInvalid: true })) return;
        const idx = parseInt(btn.dataset.index, 10);
        items.splice(idx, 1);
        render();
      });
    });

    // Add ingredient
    document.getElementById('add-ingredient-btn').addEventListener('click', () => {
      if (!syncFieldsFromDOM({ reportInvalid: true })) return;
      openIngredientSearchModal();
    });

    // Save
    document.getElementById('save-recipe-btn').addEventListener('click', async () => {
      if (saveInProgress) return;
      if (!syncFieldsFromDOM({ reportInvalid: true })) return;
      if (!name) {
        showToast('Please enter a recipe name');
        return;
      }
      if (items.length === 0) {
        showToast('Add at least one ingredient');
        return;
      }
      saveInProgress = true;
      const saveButton = document.getElementById('save-recipe-btn');
      const saveControls = [...container.querySelectorAll('input, textarea, select, button')];
      saveControls.forEach(control => { control.disabled = true; });
      saveButton.textContent = 'Saving…';

      try {
        const perServing = calcNutritionPerServing();
        const record = {
          id: recipe?.id || generateId(),
          name,
          servings,
          category,
          items: items.map(i => ({
            foodId: i.foodId,
            quantity: i.quantity,
            unit: i.unit,
            nameSnapshot: i.nameSnapshot,
            brandSnapshot: i.brandSnapshot || '',
            basisSnapshot: i.basisSnapshot ? structuredClone(i.basisSnapshot) : undefined,
            provenance: i.provenance ? structuredClone(i.provenance) : undefined,
          })),
          instructions,
          nutritionPerServing: {
            kcal: perServing.kcal,
            protein: perServing.protein,
            carbs: perServing.carbs,
            fat: perServing.fat,
            fiber: perServing.fiber,
            incomplete: perServing.incomplete,
          },
          createdAt: recipe?.createdAt || new Date().toISOString(),
        };

        const saved = await put('recipes', record, { mutationGeneration });
        recipe = saved;
        saveInProgress = false;
        showToast('Recipe saved');
        const targetHash = `#/recipes?id=${encodeURIComponent(saved.id)}`;
        render();
        if (window.location.hash !== targetHash) window.location.hash = targetHash;
      } catch (error) {
        console.error('Recipe save failed:', error);
        showToast('Could not save recipe');
        saveInProgress = false;
        saveControls.forEach(control => { control.disabled = false; });
        saveButton.textContent = 'Save Recipe';
      }
    });

    // Delete
    document.getElementById('delete-recipe-btn')?.addEventListener('click', () => {
      openDeleteConfirmation();
    });

    // Log as meal
    document.getElementById('log-meal-btn')?.addEventListener('click', () => {
      if (!syncFieldsFromDOM({ reportInvalid: true })) return;
      openLogAsMealModal();
    });
  }

  /* ---------- Ingredient Search Modal ---------- */

  function openIngredientSearchModal() {
    let searchQuery = '';
    let searchResults = [];
    let searchTimeout;
    let searchSequence = 0;
    let searchOnline = true;

    const modal = document.createElement('div');
    modal.className = 'modal-content ingredient-search-modal';
    modal.innerHTML = `
      <div class="modal-header">
        <h2>Add Ingredient</h2>
        <button class="modal-close" id="modal-close" aria-label="Close">&#10005;</button>
      </div>
      <div class="search-input-wrapper">
        <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="text" class="search-input" id="ingredient-search-input" placeholder="Search foods..." autocomplete="off" aria-label="Search for a food to add as ingredient" role="searchbox">
      </div>
      <div id="ingredient-search-results" class="ingredient-search-results">
        <div class="search-empty"><p>Type to search for foods</p></div>
      </div>
    `;

    openModal(modal);

    const searchInput = document.getElementById('ingredient-search-input');
    searchInput.focus();

    async function performIngredientSearch() {
      const resultsDiv = document.getElementById('ingredient-search-results');
      if (!resultsDiv || !searchQuery) return;
      const requestedQuery = searchQuery;
      const sequence = ++searchSequence;
      resultsDiv.innerHTML = '<div class="search-loading" role="status">Searching...</div>';

      try {
        const search = await searchFoodsWithStatus(requestedQuery, {
          localOnly: !searchOnline,
          limit: 20,
          sources: searchOnline
            ? { local: true, usda: true, off: true }
            : { local: true, usda: false, off: false },
        });
        if (sequence !== searchSequence || requestedQuery !== searchQuery) return;
        searchResults = search.foods;

        const offStatus = search.status.off;
        const remoteFailure = [search.status.off, search.status.usda]
          .find(source => source.state === 'error');
        let sourceNotice = '';
        if (!searchOnline) {
          sourceNotice = `
            <div class="search-empty" role="status">
              <p>Showing foods saved on this device only.</p>
              <button class="btn btn-outline" id="ingredient-search-online-btn">Search online</button>
            </div>`;
        } else if (offStatus.state === 'consent-required') {
          sourceNotice = `
            <div class="search-empty" role="status">
              <p>Online search is off. Enabling Open Food Facts sends food search terms and barcodes when you use online search or scanning, never your diary history.</p>
              <div class="search-actions">
                <button class="btn btn-primary" id="ingredient-enable-off-btn">Enable Open Food Facts</button>
                <button class="btn btn-outline" id="ingredient-local-only-btn">Use local foods only</button>
              </div>
            </div>`;
        } else if (remoteFailure) {
          sourceNotice = `
            <div class="search-error" role="alert">
              <p>Some online food sources are unavailable. Available and local matches are shown below.</p>
              <div class="search-actions">
                <button class="btn btn-outline" id="ingredient-retry-btn">Retry online search</button>
                <button class="btn btn-ghost" id="ingredient-local-only-btn">Use local foods only</button>
              </div>
            </div>`;
        }

        const resultsMarkup = searchResults.length > 0 ? `
          <div class="food-results">
            ${searchResults.map(food => {
              const kcal = food.nutrients?.energy?.kcal;
              const calorieDisplay = kcal != null && Number.isFinite(Number(kcal)) ? `${Math.round(Number(kcal))} kcal` : 'Calories unknown';
              const accessibleCalories = kcal != null && Number.isFinite(Number(kcal)) ? `${Math.round(Number(kcal))} calories` : 'calories unknown';
              const servingLabel = food.servingSize?.label
                || (food.servingSize ? `${food.servingSize.quantity}${food.servingSize.unit}` : '100g');
              return `
                <div class="food-result-item" data-food-id="${escapeHTML(String(food.id))}" role="button" tabindex="0" aria-label="${escapeHTML(food.name)}, ${escapeHTML(accessibleCalories)} per ${escapeHTML(String(servingLabel))}">
                  <div class="food-result-info">
                    <div class="food-result-name">${escapeHTML(food.name)}</div>
                    ${food.brand ? `<div class="food-result-brand">${escapeHTML(food.brand)}</div>` : ''}
                    <div class="food-result-meta">
                      <span class="kcal-badge">${escapeHTML(calorieDisplay)}/${escapeHTML(String(servingLabel))}</span>
                    </div>
                  </div>
                  <div class="food-result-action" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                  </div>
                </div>`;
            }).join('')}
          </div>` : `<div class="search-empty"><p>No local foods found for "${escapeHTML(searchQuery)}".</p></div>`;

        resultsDiv.innerHTML = `${sourceNotice}${resultsMarkup}`;

        resultsDiv.querySelector('#ingredient-enable-off-btn')?.addEventListener('click', async event => {
          event.currentTarget.disabled = true;
          await grantRemoteProviderConsent('openfoodfacts');
          await performIngredientSearch();
        });
        resultsDiv.querySelector('#ingredient-retry-btn')?.addEventListener('click', performIngredientSearch);
        resultsDiv.querySelector('#ingredient-local-only-btn')?.addEventListener('click', async () => {
          searchOnline = false;
          await performIngredientSearch();
        });
        resultsDiv.querySelector('#ingredient-search-online-btn')?.addEventListener('click', async () => {
          searchOnline = true;
          await performIngredientSearch();
        });

        resultsDiv.querySelectorAll('.food-result-item').forEach(el => {
          const handler = () => {
            const foodId = el.dataset.foodId;
            const food = searchResults.find(result => result.id === foodId);
            if (food) {
              closeModal();
              setTimeout(() => openIngredientPortionModal(food), 200);
            }
          };
          el.addEventListener('click', handler);
          el.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handler();
            }
          });
        });
      } catch (err) {
        if (sequence !== searchSequence) return;
        console.error('Ingredient search error:', err);
        resultsDiv.innerHTML = `
          <div class="search-error" role="alert">
            <p>Search failed. Foods saved on this device are still available.</p>
            <div class="search-actions">
              <button class="btn btn-outline" id="ingredient-retry-btn">Retry</button>
              <button class="btn btn-ghost" id="ingredient-local-only-btn">Use local foods only</button>
            </div>
          </div>`;
        resultsDiv.querySelector('#ingredient-retry-btn')?.addEventListener('click', performIngredientSearch);
        resultsDiv.querySelector('#ingredient-local-only-btn')?.addEventListener('click', async () => {
          searchOnline = false;
          await performIngredientSearch();
        });
      }
    }

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      clearTimeout(searchTimeout);
      if (!searchQuery) {
        searchSequence += 1;
        document.getElementById('ingredient-search-results').innerHTML =
          '<div class="search-empty"><p>Type to search for foods</p></div>';
        return;
      }
      searchTimeout = setTimeout(performIngredientSearch, 300);
    });

    document.getElementById('modal-close').addEventListener('click', closeModal);
  }

  /* ---------- Ingredient Portion Modal ---------- */

  function openIngredientPortionModal(food) {
    let quantity = food.servingSize?.quantity || 100;
    let unit = food.servingSize?.unit || 'g';
    let ingredientAddInProgress = false;
    const availableUnits = getUnitsForFood(food);

    function getPreviewHTML() {
      const multiplier = getNutritionMultiplierOrNull(quantity, unit, food);
      const scaled = (value, suffix, precision = 1) => value != null
        && Number.isFinite(Number(value))
        && multiplier != null
        ? `${(Number(value) * multiplier).toFixed(precision)}${suffix}`
        : 'Unknown';
      return `
        <div class="nutrition-preview">
          <div class="preview-stat"><span class="preview-label">Calories</span><span class="preview-value">${scaled(food.nutrients?.energy?.kcal, ' kcal', 0)}</span></div>
          <div class="preview-stat"><span class="preview-label">Protein</span><span class="preview-value">${scaled(food.nutrients?.macros?.protein?.g, 'g')}</span></div>
          <div class="preview-stat"><span class="preview-label">Carbs</span><span class="preview-value">${scaled(food.nutrients?.macros?.carbs?.g, 'g')}</span></div>
          <div class="preview-stat"><span class="preview-label">Fat</span><span class="preview-value">${scaled(food.nutrients?.macros?.fat?.g, 'g')}</span></div>
        </div>
      `;
    }

    const modal = document.createElement('div');
    modal.className = 'modal-content portion-editor';
    modal.innerHTML = `
      <div class="modal-header">
        <h2>${escapeHTML(food.name)}</h2>
        <button class="modal-close" id="modal-close" aria-label="Close">&#10005;</button>
      </div>
      <div class="portion-controls">
        <label class="control-group">
          <span class="control-label">Quantity</span>
          <div class="quantity-input-group">
            <button class="qty-btn qty-minus" id="qty-minus" aria-label="Decrease quantity">&#8722;</button>
            <input type="number" class="qty-input" id="qty-input" value="${quantity}" min="0.1" step="0.1" aria-label="Quantity">
            <button class="qty-btn qty-plus" id="qty-plus" aria-label="Increase quantity">+</button>
          </div>
        </label>
        <label class="control-group">
          <span class="control-label">Unit</span>
          <select class="form-input" id="unit-input" aria-label="Unit of measurement">
            ${availableUnits.map(candidate => `<option value="${escapeHTML(String(candidate.value))}" ${candidate.value === unit ? 'selected' : ''}>${escapeHTML(String(candidate.label))}</option>`).join('')}
          </select>
        </label>
      </div>
      <div id="nutrition-preview">${getPreviewHTML()}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="confirm-btn">Add Ingredient</button>
      </div>
    `;

    const dialog = openModal(modal, {
      canClose: () => !ingredientAddInProgress,
    });

    const qtyInput = dialog.querySelector('#qty-input');
    const unitInput = dialog.querySelector('#unit-input');
    const confirmButton = dialog.querySelector('#confirm-btn');
    const modalControls = [...dialog.querySelectorAll('button, input, select')];

    function updatePreview() {
      const preview = dialog.querySelector('#nutrition-preview');
      if (preview) preview.innerHTML = getPreviewHTML();
    }

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

    unitInput.addEventListener('change', (e) => {
      unit = e.target.value.trim() || 'g';
      updatePreview();
    });

    dialog.querySelector('#modal-close').addEventListener('click', () => {
      closeModal({ target: dialog, reason: 'close-button' });
    });
    dialog.querySelector('#cancel-btn').addEventListener('click', () => {
      closeModal({ target: dialog, reason: 'cancel' });
    });

    confirmButton.addEventListener('click', async () => {
      if (ingredientAddInProgress) return;
      const nextQuantity = readPositiveNumberInput(qtyInput, { report: true });
      if (nextQuantity == null) return;
      quantity = nextQuantity;
      ingredientAddInProgress = true;
      modalControls.forEach(control => { control.disabled = true; });
      confirmButton.textContent = 'Adding...';

      try {
        // Ensure food is persisted in the foods store
        const existing = await getById('foods', food.id);
        if (!existing) {
          await put('foods', food, { mutationGeneration });
        }

        foodsMap.set(food.id, food);
        const snapshot = createDraftItem(food, {
          quantity,
          unit,
          inputMethod: 'recipe ingredient',
          nutritionSource: 'Recipe ingredient',
        });
        items.push({
          foodId: food.id,
          quantity,
          unit,
          nameSnapshot: snapshot.nameSnapshot,
          brandSnapshot: snapshot.brandSnapshot,
          basisSnapshot: snapshot.basisSnapshot,
          provenance: snapshot.provenance,
        });
        closeModal({ target: dialog, force: true, reason: 'completed' });
        setTimeout(() => {
          if (container.isConnected) render();
        }, 200);
      } catch (error) {
        console.error('Could not add recipe ingredient:', error);
        showToast('Could not add ingredient');
        ingredientAddInProgress = false;
        modalControls.forEach(control => { control.disabled = false; });
        confirmButton.textContent = 'Add Ingredient';
      }
    });
  }

  /* ---------- Delete Confirmation ---------- */

  function openDeleteConfirmation() {
    const modal = document.createElement('div');
    modal.className = 'modal-content';
    modal.innerHTML = `
      <div class="modal-header">
        <h2>Delete Recipe</h2>
        <button class="modal-close" id="modal-close" aria-label="Close">&#10005;</button>
      </div>
      <p>Are you sure you want to delete "${escapeHTML(recipe.name)}"? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-delete-btn">Cancel</button>
        <button class="btn btn-delete" id="confirm-delete-btn">Delete</button>
      </div>
    `;

    let deleteInProgress = false;
    const dialog = openModal(modal, { canClose: () => !deleteInProgress });
    const modalControls = [...dialog.querySelectorAll('button')];
    const deleteButton = dialog.querySelector('#confirm-delete-btn');

    dialog.querySelector('#modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
    dialog.querySelector('#cancel-delete-btn').addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
    deleteButton.addEventListener('click', async () => {
      if (deleteInProgress) return;
      deleteInProgress = true;
      modalControls.forEach(control => { control.disabled = true; });
      deleteButton.textContent = 'Deleting…';
      try {
        await softDelete('recipes', recipe.id, { mutationGeneration });
        showToast('Recipe deleted');
        closeModal({ target: dialog, force: true, reason: 'completed' });
        window.location.hash = '#/recipes';
      } catch (error) {
        console.error('Recipe delete failed:', error);
        showToast('Could not delete recipe');
        deleteInProgress = false;
        modalControls.forEach(control => { control.disabled = false; });
        deleteButton.textContent = 'Delete';
      }
    });
  }

  /* ---------- Log as Meal Modal ---------- */

  function openLogAsMealModal() {
    let portionServings = 1;
    let mealType = getMealTypeForTime();
    const idempotencyKey = createIdempotencyKey('recipe');

    const modal = document.createElement('div');
    modal.className = 'modal-content';
    modal.innerHTML = `
      <div class="modal-header">
        <h2>Log "${escapeHTML(name || recipe.name)}"</h2>
        <button class="modal-close" id="modal-close" aria-label="Close">&#10005;</button>
      </div>
      <div class="portion-controls">
        <label class="control-group">
          <span class="control-label">Servings</span>
          <div class="quantity-input-group">
            <button class="qty-btn qty-minus" id="log-qty-minus" aria-label="Decrease servings">&#8722;</button>
            <input type="number" class="qty-input" id="log-servings-input" value="${portionServings}" min="0.25" step="0.25" aria-label="Number of servings to log">
            <button class="qty-btn qty-plus" id="log-qty-plus" aria-label="Increase servings">+</button>
          </div>
        </label>
        <label class="control-group">
          <span class="control-label">Meal Type</span>
          <select class="meal-type-select" id="log-meal-type" aria-label="Meal type">
            <option value="breakfast" ${mealType === 'breakfast' ? 'selected' : ''}>Breakfast</option>
            <option value="lunch" ${mealType === 'lunch' ? 'selected' : ''}>Lunch</option>
            <option value="dinner" ${mealType === 'dinner' ? 'selected' : ''}>Dinner</option>
            <option value="snacks" ${mealType === 'snacks' ? 'selected' : ''}>Snacks</option>
          </select>
        </label>
      </div>
      <div id="log-nutrition-preview"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-log-btn">Cancel</button>
        <button class="btn btn-primary" id="confirm-log-btn">Log Meal</button>
      </div>
    `;

    const dialog = openModal(modal, { canClose: () => !mealLogInProgress });

    const servingsInput = dialog.querySelector('#log-servings-input');
    const logButton = dialog.querySelector('#confirm-log-btn');
    const modalControls = [...dialog.querySelectorAll('button, input, select')];

    function updateLogPreview() {
      const nextServings = readPositiveNumberInput(servingsInput, { min: 0.25 });
      portionServings = nextServings ?? NaN;
      const perServing = calcNutritionPerServing();
      const display = (key, suffix = '') => perServing.incomplete?.includes(key)
        || !Number.isFinite(portionServings)
        ? 'Unknown'
        : `${Math.round(perServing[key] * portionServings)}${suffix}`;
      const preview = dialog.querySelector('#log-nutrition-preview');
      if (preview) {
        preview.innerHTML = `
          <div class="nutrition-preview">
            <div class="preview-stat"><span class="preview-label">Calories</span><span class="preview-value">${display('kcal', ' kcal')}</span></div>
            <div class="preview-stat"><span class="preview-label">Protein</span><span class="preview-value">${display('protein', 'g')}</span></div>
            <div class="preview-stat"><span class="preview-label">Carbs</span><span class="preview-value">${display('carbs', 'g')}</span></div>
            <div class="preview-stat"><span class="preview-label">Fat</span><span class="preview-value">${display('fat', 'g')}</span></div>
          </div>
        `;
      }
    }

    updateLogPreview();

    dialog.querySelector('#log-qty-minus').addEventListener('click', () => {
      const current = readPositiveNumberInput(servingsInput, { report: true, min: 0.25 });
      if (current == null) return;
      portionServings = Math.max(0.25, current - 0.25);
      servingsInput.value = portionServings;
      updateLogPreview();
    });

    dialog.querySelector('#log-qty-plus').addEventListener('click', () => {
      const current = readPositiveNumberInput(servingsInput, { report: true, min: 0.25 });
      if (current == null) return;
      portionServings = current + 0.25;
      servingsInput.value = portionServings;
      updateLogPreview();
    });

    servingsInput.addEventListener('change', () => {
      readPositiveNumberInput(servingsInput, { report: true, min: 0.25 });
      updateLogPreview();
    });

    dialog.querySelector('#log-meal-type').addEventListener('change', (e) => {
      mealType = e.target.value;
    });

    dialog.querySelector('#modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
    dialog.querySelector('#cancel-log-btn').addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));

    logButton.addEventListener('click', async () => {
      if (mealLogInProgress) return;
      const nextServings = readPositiveNumberInput(servingsInput, { report: true, min: 0.25 });
      if (nextServings == null) return;
      portionServings = nextServings;
      mealLogInProgress = true;
      modalControls.forEach(control => { control.disabled = true; });
      logButton.textContent = 'Logging…';

      // Build meal items from recipe ingredients, scaled by portion
      const mealItems = items.map(item => {
        const food = foodsMap.get(item.foodId);
        const recipeServings = servings || 1;
        const itemQty = scaleRecipeItemQuantity(item.quantity, recipeServings, portionServings);
        const basis = item.basisSnapshot;
        const historicalFood = basis ? {
          id: item.foodId,
          name: item.nameSnapshot || food?.name || 'Recipe ingredient',
          brand: item.brandSnapshot || food?.brand || '',
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
          source: { type: 'recipe' },
        } : food;
        if (!historicalFood) {
          return {
            foodId: item.foodId,
            nameSnapshot: item.nameSnapshot || 'Recipe ingredient',
            quantity: itemQty,
            unit: item.unit,
            nutrients: { kcal: null, protein: null, carbs: null, fat: null, fiber: null, sodium: null },
            provenance: { nutritionSource: 'Recipe ingredient', inputMethod: 'recipe' },
          };
        }
        return toMealItem(createDraftItem(historicalFood, {
          name: item.nameSnapshot || historicalFood.name,
          quantity: itemQty,
          unit: item.unit,
          inputMethod: 'recipe',
          nutritionSource: 'Recipe ingredient',
        }));
      });

      const meal = {
        date: todayStr(),
        type: mealType,
        items: mealItems,
        recipeId: recipe.id,
        createdAt: new Date().toISOString(),
      };

      try {
        await createMeal(meal, { idempotencyKey, mutationGeneration });
        showToast(`${name || recipe.name} logged to ${mealType.charAt(0).toUpperCase() + mealType.slice(1)}`);
        closeModal({ target: dialog, force: true, reason: 'completed' });
        setTimeout(() => {
          window.location.hash = '#/diary';
        }, 500);
      } catch (error) {
        console.error('Recipe logging failed:', error);
        showToast('Could not log recipe');
        mealLogInProgress = false;
        modalControls.forEach(control => { control.disabled = false; });
        logButton.textContent = 'Log Meal';
      }
    });
  }

  render();
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getMealTypeForTime() {
  const hour = new Date().getHours();
  if (hour < 12) return 'breakfast';
  if (hour < 17) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snacks';
}
