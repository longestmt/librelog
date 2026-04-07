import { getAll, getById, put, softDelete } from '../data/db.js';
import { searchFoods } from '../engine/food-search.js';
import { todayStr } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { getNutritionMultiplier } from '../utils/units.js';

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function renderRecipesPage(container, queryString) {
  const params = new URLSearchParams(queryString);
  const recipeId = params.get('id');
  const isNew = params.get('new') === '1';

  if (recipeId || isNew) {
    renderRecipeDetail(container, recipeId);
  } else {
    renderRecipeList(container);
  }
}

/* ------------------------------------------------------------------ */
/*  Recipe List View                                                   */
/* ------------------------------------------------------------------ */

async function renderRecipeList(container) {
  const recipes = await getAll('recipes');

  container.innerHTML = `
    <div class="recipes-page" role="main" aria-label="Recipes">
      <div class="page-header">
        <h1 class="page-title">Recipes</h1>
        <button class="btn btn-primary" id="new-recipe-btn" aria-label="Create new recipe">New Recipe</button>
      </div>

      ${recipes.length === 0 ? `
        <div class="empty-state" role="status">
          <p>No recipes yet. Create your first recipe!</p>
        </div>
      ` : `
        <div class="recipe-list" role="list" aria-label="Saved recipes">
          ${recipes.map(recipe => {
            const perServing = recipe.nutritionPerServing || {};
            const kcal = Math.round(perServing.kcal || 0);
            const protein = Math.round(perServing.protein || 0);
            const carbs = Math.round(perServing.carbs || 0);
            const fat = Math.round(perServing.fat || 0);
            return `
              <div class="recipe-card" data-recipe-id="${recipe.id}" role="listitem" tabindex="0"
                   aria-label="${escapeHTML(recipe.name)}, ${kcal} calories per serving">
                <div class="recipe-card-info">
                  <div class="recipe-card-name">${escapeHTML(recipe.name)}</div>
                  <div class="recipe-card-meta">
                    <span class="recipe-servings">${recipe.servings || 1} serving${(recipe.servings || 1) !== 1 ? 's' : ''}</span>
                    <span class="recipe-kcal">${kcal} kcal/serving</span>
                    <span class="macro-summary">${protein}P ${carbs}C ${fat}F</span>
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
    </div>
  `;

  document.getElementById('new-recipe-btn').addEventListener('click', () => {
    window.location.hash = '#/recipes?new=1';
  });

  container.querySelectorAll('.recipe-card').forEach(card => {
    const handler = () => {
      const id = card.dataset.recipeId;
      window.location.hash = `#/recipes?id=${id}`;
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
  let recipe = recipeId ? await getById('recipes', recipeId) : null;

  // Working state
  let name = recipe?.name || '';
  let servings = recipe?.servings || 1;
  let category = recipe?.category || '';
  let instructions = recipe?.instructions || '';
  let items = recipe?.items ? recipe.items.map(i => ({ ...i })) : [];

  // Resolve all foods for current ingredients
  const foodsMap = new Map();
  for (const item of items) {
    const food = await getById('foods', item.foodId);
    if (food) foodsMap.set(item.foodId, food);
  }

  function calcNutritionPerServing() {
    const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
    for (const item of items) {
      const food = foodsMap.get(item.foodId);
      if (!food) continue;
      const multiplier = getNutritionMultiplier(item.quantity, item.unit, food);
      totals.kcal += (food.nutrients?.energy?.kcal || 0) * multiplier;
      totals.protein += (food.nutrients?.macros?.protein?.g || 0) * multiplier;
      totals.carbs += (food.nutrients?.macros?.carbs?.g || 0) * multiplier;
      totals.fat += (food.nutrients?.macros?.fat?.g || 0) * multiplier;
      totals.fiber += (food.nutrients?.fiber?.g || 0) * multiplier;
    }
    const s = servings || 1;
    return {
      kcal: totals.kcal / s,
      protein: totals.protein / s,
      carbs: totals.carbs / s,
      fat: totals.fat / s,
      fiber: totals.fiber / s,
    };
  }

  function render() {
    const perServing = calcNutritionPerServing();

    container.innerHTML = `
      <div class="recipes-page recipe-detail" role="main" aria-label="${recipe ? 'Edit recipe' : 'New recipe'}">
        <div class="page-header">
          <button class="btn btn-ghost" id="back-btn" aria-label="Back to recipes">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Back
          </button>
        </div>

        <div class="form-group">
          <label class="control-label" for="recipe-name">Recipe Name</label>
          <input type="text" id="recipe-name" class="form-input" value="${escapeHTML(name)}" placeholder="e.g., Overnight Oats" required aria-required="true">
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="control-label" for="recipe-servings">Servings Yield</label>
            <input type="number" id="recipe-servings" class="form-input" value="${servings}" min="1" step="1" aria-label="Number of servings this recipe yields">
          </div>
          <div class="form-group">
            <label class="control-label" for="recipe-category">Category</label>
            <input type="text" id="recipe-category" class="form-input" value="${escapeHTML(category)}" placeholder="e.g., Breakfast, Main, Snack">
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
                const food = foodsMap.get(item.foodId);
                const foodName = food?.name || 'Unknown food';
                const multiplier = food ? getNutritionMultiplier(item.quantity, item.unit, food) : 0;
                const kcal = food ? Math.round((food.nutrients?.energy?.kcal || 0) * multiplier) : 0;
                return `
                  <div class="ingredient-item" role="listitem">
                    <div class="ingredient-info">
                      <span class="ingredient-name">${escapeHTML(foodName)}</span>
                      <span class="ingredient-portion">${item.quantity} ${item.unit}</span>
                      <span class="ingredient-kcal">${kcal} kcal</span>
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
        <div class="recipe-section nutrition-summary-section" role="region" aria-label="Per-serving nutrition">
          <h3 class="section-title">Per-Serving Nutrition</h3>
          <div class="nutrition-grid">
            <div class="nutrition-stat">
              <span class="nutrition-stat-value">${Math.round(perServing.kcal)}</span>
              <span class="nutrition-stat-label">kcal</span>
            </div>
            <div class="nutrition-stat">
              <span class="nutrition-stat-value">${Math.round(perServing.protein)}g</span>
              <span class="nutrition-stat-label">Protein</span>
            </div>
            <div class="nutrition-stat">
              <span class="nutrition-stat-value">${Math.round(perServing.carbs)}g</span>
              <span class="nutrition-stat-label">Carbs</span>
            </div>
            <div class="nutrition-stat">
              <span class="nutrition-stat-value">${Math.round(perServing.fat)}g</span>
              <span class="nutrition-stat-label">Fat</span>
            </div>
            <div class="nutrition-stat">
              <span class="nutrition-stat-value">${Math.round(perServing.fiber)}g</span>
              <span class="nutrition-stat-label">Fiber</span>
            </div>
          </div>
        </div>

        <!-- Instructions -->
        <div class="form-group">
          <label class="control-label" for="recipe-instructions">Instructions (optional)</label>
          <textarea id="recipe-instructions" class="form-input form-textarea" rows="5" placeholder="Add preparation steps...">${escapeHTML(instructions)}</textarea>
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

  function syncFieldsFromDOM() {
    const nameInput = document.getElementById('recipe-name');
    const servingsInput = document.getElementById('recipe-servings');
    const categoryInput = document.getElementById('recipe-category');
    const instructionsInput = document.getElementById('recipe-instructions');
    if (nameInput) name = nameInput.value.trim();
    if (servingsInput) servings = parseInt(servingsInput.value, 10) || 1;
    if (categoryInput) category = categoryInput.value.trim();
    if (instructionsInput) instructions = instructionsInput.value;
  }

  function bindDetailEvents() {
    document.getElementById('back-btn').addEventListener('click', () => {
      window.location.hash = '#/recipes';
    });

    // Live-sync servings to update nutrition display
    document.getElementById('recipe-servings').addEventListener('change', () => {
      syncFieldsFromDOM();
      render();
    });

    // Remove ingredient buttons
    container.querySelectorAll('.ingredient-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        syncFieldsFromDOM();
        const idx = parseInt(btn.dataset.index, 10);
        items.splice(idx, 1);
        render();
      });
    });

    // Add ingredient
    document.getElementById('add-ingredient-btn').addEventListener('click', () => {
      syncFieldsFromDOM();
      openIngredientSearchModal();
    });

    // Save
    document.getElementById('save-recipe-btn').addEventListener('click', async () => {
      syncFieldsFromDOM();
      if (!name) {
        showToast('Please enter a recipe name');
        return;
      }

      const perServing = calcNutritionPerServing();
      const record = {
        id: recipe?.id || generateId(),
        name,
        servings,
        category,
        items: items.map(i => ({ foodId: i.foodId, quantity: i.quantity, unit: i.unit })),
        instructions,
        nutritionPerServing: {
          kcal: perServing.kcal,
          protein: perServing.protein,
          carbs: perServing.carbs,
          fat: perServing.fat,
          fiber: perServing.fiber,
        },
        createdAt: recipe?.createdAt || new Date().toISOString(),
      };

      const saved = await put('recipes', record);
      recipe = saved;
      showToast('Recipe saved');
      window.location.hash = `#/recipes?id=${saved.id}`;
    });

    // Delete
    document.getElementById('delete-recipe-btn')?.addEventListener('click', () => {
      openDeleteConfirmation();
    });

    // Log as meal
    document.getElementById('log-meal-btn')?.addEventListener('click', () => {
      syncFieldsFromDOM();
      openLogAsMealModal();
    });
  }

  /* ---------- Ingredient Search Modal ---------- */

  function openIngredientSearchModal() {
    let searchQuery = '';
    let searchResults = [];
    let searchTimeout;

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
      <div id="ingredient-search-results" class="search-content">
        <div class="search-empty"><p>Type to search for foods</p></div>
      </div>
    `;

    openModal(modal);

    const searchInput = document.getElementById('ingredient-search-input');
    searchInput.focus();

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      clearTimeout(searchTimeout);
      if (!searchQuery) {
        document.getElementById('ingredient-search-results').innerHTML =
          '<div class="search-empty"><p>Type to search for foods</p></div>';
        return;
      }
      searchTimeout = setTimeout(async () => {
        const resultsDiv = document.getElementById('ingredient-search-results');
        resultsDiv.innerHTML = '<div class="search-loading">Searching...</div>';
        try {
          searchResults = await searchFoods(searchQuery, { localOnly: false, limit: 20 });
          if (!searchResults || searchResults.length === 0) {
            resultsDiv.innerHTML = `<div class="search-empty"><p>No foods found for "${escapeHTML(searchQuery)}"</p></div>`;
            return;
          }
          resultsDiv.innerHTML = `
            <div class="food-results">
              ${searchResults.map(food => {
                const kcal = food.nutrients?.energy?.kcal || 0;
                const servingLabel = food.servingSize ? `${food.servingSize.quantity}${food.servingSize.unit}` : '100g';
                return `
                  <div class="food-result-item" data-food-id="${food.id}" role="button" tabindex="0" aria-label="${escapeHTML(food.name)}, ${Math.round(kcal)} calories per ${servingLabel}">
                    <div class="food-result-info">
                      <div class="food-result-name">${escapeHTML(food.name)}</div>
                      ${food.brand ? `<div class="food-result-brand">${escapeHTML(food.brand)}</div>` : ''}
                      <div class="food-result-meta">
                        <span class="kcal-badge">${Math.round(kcal)} kcal/${servingLabel}</span>
                      </div>
                    </div>
                    <div class="food-result-action" aria-hidden="true">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `;

          resultsDiv.querySelectorAll('.food-result-item').forEach(el => {
            const handler = () => {
              const foodId = el.dataset.foodId;
              const food = searchResults.find(f => f.id === foodId);
              if (food) {
                closeModal();
                setTimeout(() => openIngredientPortionModal(food), 200);
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
        } catch (err) {
          console.error('Ingredient search error:', err);
          resultsDiv.innerHTML = '<div class="search-error"><p>Error searching foods. Please try again.</p></div>';
        }
      }, 300);
    });

    document.getElementById('modal-close').addEventListener('click', closeModal);
  }

  /* ---------- Ingredient Portion Modal ---------- */

  function openIngredientPortionModal(food) {
    let quantity = food.servingSize?.quantity || 100;
    let unit = food.servingSize?.unit || 'g';

    function getPreviewHTML() {
      const multiplier = getNutritionMultiplier(quantity, unit, food);
      const kcal = Math.round((food.nutrients?.energy?.kcal || 0) * multiplier);
      const protein = ((food.nutrients?.macros?.protein?.g || 0) * multiplier).toFixed(1);
      const carbs = ((food.nutrients?.macros?.carbs?.g || 0) * multiplier).toFixed(1);
      const fat = ((food.nutrients?.macros?.fat?.g || 0) * multiplier).toFixed(1);
      return `
        <div class="nutrition-preview">
          <div class="preview-stat"><span class="preview-label">Calories</span><span class="preview-value">${kcal} kcal</span></div>
          <div class="preview-stat"><span class="preview-label">Protein</span><span class="preview-value">${protein}g</span></div>
          <div class="preview-stat"><span class="preview-label">Carbs</span><span class="preview-value">${carbs}g</span></div>
          <div class="preview-stat"><span class="preview-label">Fat</span><span class="preview-value">${fat}g</span></div>
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
          <input type="text" class="form-input" id="unit-input" value="${escapeHTML(unit)}" aria-label="Unit of measurement">
        </label>
      </div>
      <div id="nutrition-preview">${getPreviewHTML()}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="confirm-btn">Add Ingredient</button>
      </div>
    `;

    openModal(modal);

    const qtyInput = document.getElementById('qty-input');
    const unitInput = document.getElementById('unit-input');

    function updatePreview() {
      const preview = document.getElementById('nutrition-preview');
      if (preview) preview.innerHTML = getPreviewHTML();
    }

    document.getElementById('qty-minus').addEventListener('click', () => {
      quantity = Math.max(0.1, parseFloat(qtyInput.value) - 0.5);
      qtyInput.value = quantity;
      updatePreview();
    });

    document.getElementById('qty-plus').addEventListener('click', () => {
      quantity = parseFloat(qtyInput.value) + 0.5;
      qtyInput.value = quantity.toFixed(1);
      updatePreview();
    });

    qtyInput.addEventListener('change', () => {
      quantity = parseFloat(qtyInput.value) || 100;
      updatePreview();
    });

    unitInput.addEventListener('change', (e) => {
      unit = e.target.value.trim() || 'g';
      updatePreview();
    });

    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('cancel-btn').addEventListener('click', closeModal);

    document.getElementById('confirm-btn').addEventListener('click', async () => {
      // Ensure food is persisted in the foods store
      const existing = await getById('foods', food.id);
      if (!existing) {
        await put('foods', food);
      }

      foodsMap.set(food.id, food);
      items.push({ foodId: food.id, quantity, unit });
      closeModal();
      setTimeout(() => render(), 200);
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

    openModal(modal);

    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('cancel-delete-btn').addEventListener('click', closeModal);
    document.getElementById('confirm-delete-btn').addEventListener('click', async () => {
      await softDelete('recipes', recipe.id);
      showToast('Recipe deleted');
      closeModal();
      window.location.hash = '#/recipes';
    });
  }

  /* ---------- Log as Meal Modal ---------- */

  function openLogAsMealModal() {
    let portionServings = 1;
    let mealType = getMealTypeForTime();

    const modal = document.createElement('div');
    modal.className = 'modal-content';
    modal.innerHTML = `
      <div class="modal-header">
        <h2>Log "${escapeHTML(recipe.name)}"</h2>
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

    openModal(modal);

    const servingsInput = document.getElementById('log-servings-input');

    function updateLogPreview() {
      portionServings = parseFloat(servingsInput.value) || 1;
      const perServing = recipe.nutritionPerServing || calcNutritionPerServing();
      const preview = document.getElementById('log-nutrition-preview');
      if (preview) {
        preview.innerHTML = `
          <div class="nutrition-preview">
            <div class="preview-stat"><span class="preview-label">Calories</span><span class="preview-value">${Math.round(perServing.kcal * portionServings)} kcal</span></div>
            <div class="preview-stat"><span class="preview-label">Protein</span><span class="preview-value">${Math.round(perServing.protein * portionServings)}g</span></div>
            <div class="preview-stat"><span class="preview-label">Carbs</span><span class="preview-value">${Math.round(perServing.carbs * portionServings)}g</span></div>
            <div class="preview-stat"><span class="preview-label">Fat</span><span class="preview-value">${Math.round(perServing.fat * portionServings)}g</span></div>
          </div>
        `;
      }
    }

    updateLogPreview();

    document.getElementById('log-qty-minus').addEventListener('click', () => {
      portionServings = Math.max(0.25, parseFloat(servingsInput.value) - 0.25);
      servingsInput.value = portionServings;
      updateLogPreview();
    });

    document.getElementById('log-qty-plus').addEventListener('click', () => {
      portionServings = parseFloat(servingsInput.value) + 0.25;
      servingsInput.value = portionServings;
      updateLogPreview();
    });

    servingsInput.addEventListener('change', updateLogPreview);

    document.getElementById('log-meal-type').addEventListener('change', (e) => {
      mealType = e.target.value;
    });

    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('cancel-log-btn').addEventListener('click', closeModal);

    document.getElementById('confirm-log-btn').addEventListener('click', async () => {
      const perServing = recipe.nutritionPerServing || calcNutritionPerServing();
      const scaledNutrients = {
        kcal: perServing.kcal * portionServings,
        protein: perServing.protein * portionServings,
        carbs: perServing.carbs * portionServings,
        fat: perServing.fat * portionServings,
        fiber: (perServing.fiber || 0) * portionServings,
        sodium: 0,
      };

      // Build meal items from recipe ingredients, scaled by portion
      const mealItems = items.map(item => {
        const food = foodsMap.get(item.foodId);
        const recipeServings = recipe.servings || 1;
        const itemQty = (item.quantity / recipeServings) * portionServings;
        const multiplier = food ? getNutritionMultiplier(itemQty, item.unit, food) : 0;
        return {
          foodId: item.foodId,
          quantity: parseFloat(itemQty.toFixed(2)),
          unit: item.unit,
          nutrients: {
            kcal: food ? (food.nutrients?.energy?.kcal || 0) * multiplier : 0,
            protein: food ? (food.nutrients?.macros?.protein?.g || 0) * multiplier : 0,
            carbs: food ? (food.nutrients?.macros?.carbs?.g || 0) * multiplier : 0,
            fat: food ? (food.nutrients?.macros?.fat?.g || 0) * multiplier : 0,
            fiber: food ? (food.nutrients?.fiber?.g || 0) * multiplier : 0,
            sodium: food ? (food.nutrients?.sodium?.mg || 0) * multiplier : 0,
          },
        };
      });

      const meal = {
        id: generateId(),
        date: todayStr(),
        type: mealType,
        items: mealItems,
        recipeId: recipe.id,
        createdAt: new Date().toISOString(),
      };

      await put('meals', meal);
      showToast(`${recipe.name} logged to ${mealType.charAt(0).toUpperCase() + mealType.slice(1)}`);
      closeModal();
      setTimeout(() => {
        window.location.hash = '#/diary';
      }, 500);
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
