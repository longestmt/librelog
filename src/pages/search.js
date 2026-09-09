/**
 * search.js — Unified food search & add page
 * Modes: text search, barcode scan, AI photo, AI voice, AI text
 */

import { getAll, getById, put, softDelete } from '../data/db.js';
import { searchFoods, searchFoodsWithStatus, getRecentFoods, getFavoriteFoods } from '../engine/food-search.js';
import { lookupBarcode } from '../integrations/openfoodfacts.js';
import { todayStr, formatDate } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast, showUndoToast } from '../components/toast.js';
import {
  hasPrivacyConsent,
  requestPrivacyConsent,
} from '../components/privacy-consent.js';
import { getUnitsForFood, getNutritionMultiplierOrNull } from '../utils/units.js';
import { readPositiveNumberInput } from '../utils/form-validation.js';
import { createDeterministicKey, createMeal } from '../data/meal-commands.js';
import {
  clearAddDraftIfCurrent,
  clearAddDraftIfCurrentLocked,
  createDraftItem,
  createDraftItemFromMealItem,
  getDraftTotals,
  isAddDraftCurrent,
  loadAddDraft,
  loadAddDraftForDestination,
  rebaseFoodNutritionForPortion,
  restoreAddDraftIfVacant,
  saveAddDraftIfCurrent,
  toMealItem,
  updateDraftItem,
  withAddDraftLock,
} from '../data/add-draft.js';
import {
  assertDataMutationGenerationCurrent,
  captureDataMutationGeneration,
} from '../data/operation-locks.js';

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
const MODES = [
  { key: 'search', label: 'Search', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' },
  { key: 'scan', label: 'Scan', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" x2="17" y1="12" y2="12"/></svg>' },
  { key: 'ai', label: 'Describe', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' },
];

// Lazy-loaded modules
let Quagga = null;
let aiClientMod = null;
let imageProcessorMod = null;
let voiceParserMod = null;
let clarificationMod = null;

async function loadQuagga() { if (Quagga) return Quagga; try { const m = await import('@ericblade/quagga2'); Quagga = m.default || m; return Quagga; } catch { return null; } }
async function loadAI() { if (aiClientMod) return aiClientMod; try { aiClientMod = await import('../integrations/aiClient.js'); return aiClientMod; } catch { return null; } }
async function loadImageProcessor() { if (imageProcessorMod) return imageProcessorMod; try { imageProcessorMod = await import('../integrations/imageProcessor.js'); return imageProcessorMod; } catch { return null; } }
async function loadVoiceParser() { if (voiceParserMod) return voiceParserMod; try { voiceParserMod = await import('../integrations/voiceParser.js'); return voiceParserMod; } catch { return null; } }
async function loadClarification() { if (clarificationMod) return clarificationMod; try { clarificationMod = await import('../integrations/clarificationEngine.js'); return clarificationMod; } catch { return null; } }

export async function renderSearchPage(container, queryString) {
  const pageMutationGeneration = captureDataMutationGeneration();
  const params = new URLSearchParams(queryString);
  const mealTypeParam = params.get('meal') || 'lunch';
  let mealType = MEAL_TYPES.find(type => type.toLowerCase() === mealTypeParam.toLowerCase()) || 'Lunch';
  let mode = params.get('foodId') ? 'search' : (params.get('mode') || null);
  let modeInitialized = false;
  const dateParam = params.get('date');
  let targetDate = isCalendarDate(dateParam) ? dateParam : todayStr();
  let draft = await loadAddDraftForDestination({
    date: targetDate,
    mealType: mealType.toLowerCase(),
    mutationGeneration: pageMutationGeneration,
  });
  targetDate = draft.date;
  mealType = MEAL_TYPES.find(type => type.toLowerCase() === draft.mealType) || 'Lunch';

  let searchQuery = '';
  let searchResults = [];
  let lastSearchStatus = null;
  let searchTimeout;
  let searchSources = { local: true, usda: true, off: true };
  let offPage = 1;
  let usdaPage = 1;
  let loadMoreInProgress = false;

  // Scanner state
  let cameraStarted = false;
  let cameraStartGeneration = 0;
  let scannerDetectionHandler = null;

  // AI state
  let aiProcessing = false;
  let aiResults = null;
  let clarificationData = null;
  let aiAttachedPhoto = null;
  let aiTextValue = '';
  let recorder = null;
  let isRecording = false;
  let voiceStartGeneration = 0;
  let amplitudeInterval = null;
  let aiProvider = null;
  let aiInputMethod = 'typed';
  let aiSelected = new Set();
  let saveInProgress = false;
  let activeReviewModal = null;
  let saveFamiliarSelected = false;
  let familiarMealName = '';
  let discardConfirming = false;
  let familiarMeals = [];
  let availableModes = [];
  let searchSequence = 0;
  let modeRenderSequence = 0;
  let scanLookupSequence = 0;
  let preselectedHandled = false;
  let aiAbortController = null;
  let searchAbortController = null;
  let searchBarcodeAbortController = null;
  let scanBarcodeAbortController = null;
  let disposed = false;
  let privacySourcesInitialized = false;
  const draftReviewTitleId = `draft-review-title-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  async function render() {
    if (!privacySourcesInitialized) {
      const [offConsent, usdaConsent] = await Promise.all([
        hasPrivacyConsent('openfoodfacts'),
        hasPrivacyConsent('usda'),
      ]);
      searchSources.off = offConsent;
      searchSources.usda = usdaConsent;
      privacySourcesInitialized = true;
    }
    // Determine which modes to show based on AI config
    const ai = await loadAI();
    const aiConfigured = ai ? await ai.isAIConfigured() : false;
    aiProvider = null;
    if (aiConfigured && ai) { const cfg = await ai.getAIConfig(); aiProvider = cfg.provider; }

    availableModes = MODES.filter(m => {
      if (m.key === 'ai') return aiConfigured;
      return true;
    });

    if (!modeInitialized) {
      mode = availableModes.some(candidate => candidate.key === mode)
        ? mode
        : (aiConfigured ? 'ai' : 'search');
      modeInitialized = true;
      const settings = await getAll('settings');
      familiarMeals = settings
        .filter(setting => setting.key?.startsWith('template_')
          && setting.value?.kind === 'meal'
          && Array.isArray(setting.value.items))
        .map(setting => ({ key: setting.key, ...setting.value }))
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
        .slice(0, 6);
    }

    // If current mode is hidden, fall back to search
    if (!availableModes.some(m => m.key === mode)) mode = 'search';

    container.innerHTML = `
      <div class="search-page add-workspace">
        <div class="add-workspace-header">
          <div>
            <p class="add-workspace-eyebrow">Meal draft</p>
            <h1>Add food</h1>
          </div>
          <button class="meal-type-badge" id="meal-type-toggle" aria-label="Add to ${mealType} on ${formatDate(targetDate)}. Change destination.">
            <span>${mealType}</span><small>${formatDate(targetDate)}</small>
          </button>
        </div>
        <!-- The configured/default method is the primary workspace. -->
        <div id="add-primary-tool"></div>
        <div class="search-mode-content" id="mode-content"></div>
        <!-- Other acquisition methods remain secondary and feed this draft. -->
        <div id="add-secondary-tools"></div>
        <div id="add-draft-tray" class="add-draft-tray" aria-live="polite"></div>
      </div>
    `;

    document.getElementById('meal-type-toggle')?.addEventListener('click', openDestinationPicker);

    renderToolControls();
    renderModeContent();
    renderDraftTray();
  }

  function renderToolControls() {
    const primary = availableModes.find(candidate => candidate.key === mode) || availableModes[0];
    const primaryRoot = document.getElementById('add-primary-tool');
    const secondaryRoot = document.getElementById('add-secondary-tools');
    if (!primaryRoot || !secondaryRoot || !primary) return;
    const primaryLabel = primary.key === 'ai' ? 'Describe your meal' : primary.key === 'search' ? 'Search foods' : 'Scan a barcode';
    primaryRoot.innerHTML = `
      <h2 class="add-primary-tool" id="current-add-tool" tabindex="-1">
        ${primary.icon}<span>${primaryLabel}</span>
      </h2>
    `;
    const secondary = availableModes.filter(candidate => candidate.key !== mode);
    secondaryRoot.innerHTML = secondary.length ? `
      <div class="add-secondary-tools" role="group" aria-label="Other ways to add food">
        <span class="add-secondary-label">Other ways to add</span>
        <div class="add-secondary-buttons">
          ${secondary.map(candidate => `
            <button class="add-secondary-tool" data-mode="${candidate.key}" aria-pressed="false">
              ${candidate.icon}<span>${candidate.key === 'search' ? 'Search foods' : candidate.key === 'scan' ? 'Scan barcode' : 'Describe meal'}</span>
            </button>
          `).join('')}
        </div>
      </div>
    ` : '';
    secondaryRoot.querySelectorAll('.add-secondary-tool').forEach(button => {
      button.addEventListener('click', async () => {
        stopScanner();
        stopVoice();
        mode = button.dataset.mode;
        renderToolControls();
        await renderModeContent();
        const primaryInput = mode === 'search'
          ? document.getElementById('food-search-input')
          : mode === 'ai'
            ? document.getElementById('ai-text-input')
            : document.getElementById('barcode-manual-input');
        (primaryInput || document.getElementById('current-add-tool'))?.focus();
      });
    });
  }

  async function renderModeContent() {
    const el = document.getElementById('mode-content');
    if (!el) return;
    const renderSequence = ++modeRenderSequence;

    switch (mode) {
      case 'search': await renderSearchMode(el, renderSequence); break;
      case 'scan': renderScanMode(el); break;
      case 'ai': renderAIMode(el); break;
    }
  }

  async function persistDraft(nextDraft = draft, {
    mutationGeneration = pageMutationGeneration,
  } = {}) {
    const expectedDraft = structuredClone(draft);
    const candidate = {
      ...structuredClone(nextDraft),
      date: targetDate,
      mealType: mealType.toLowerCase(),
    };
    try {
      // The page generation invalidates every stale Add workspace after a
      // clear/restore. An acquisition generation also invalidates a lookup or
      // AI result that was already in flight when data changed.
      assertDataMutationGenerationCurrent(pageMutationGeneration);
      assertDataMutationGenerationCurrent(mutationGeneration);
      const savedDraft = await saveAddDraftIfCurrent(expectedDraft, candidate, {
        mutationGeneration: pageMutationGeneration,
      });
      if (!savedDraft) {
        showToast('This draft changed in another tab. Reload Add Food to keep those changes.', 'error', 7000);
        return false;
      }
      draft = savedDraft;
    } catch (error) {
      console.error('Could not persist add draft:', error);
      showToast('Draft could not be saved on this device. Nothing was added.', 'error');
      return false;
    }
    renderDraftTray();
    const destination = document.getElementById('meal-type-toggle');
    if (destination) {
      destination.innerHTML = `<span>${mealType}</span><small>${formatDate(targetDate)}</small>`;
      destination.setAttribute('aria-label', `Add to ${mealType} on ${formatDate(targetDate)}. Change destination.`);
    }
    return true;
  }

  function renderDraftTray() {
    const tray = document.getElementById('add-draft-tray');
    if (!tray) return;
    const totals = getDraftTotals(draft);
    const count = draft.items.length;
    tray.classList.toggle('is-empty', count === 0);
    tray.innerHTML = `
      <div class="add-draft-summary">
        <span class="add-draft-count">${count} item${count === 1 ? '' : 's'}</span>
        <span><strong>${totals.incomplete.includes('kcal') ? '—' : totals.kcal}</strong> kcal</span>
        <span><strong>${totals.incomplete.includes('protein') ? '—' : totals.protein}</strong>${totals.incomplete.includes('protein') ? '' : 'g'} protein</span>
      </div>
      <button class="btn btn-primary" id="review-draft-btn" ${count === 0 ? 'disabled' : ''}>
        Review meal
      </button>
    `;
    document.getElementById('review-draft-btn')?.addEventListener('click', openDraftReview);
  }

  function openDestinationPicker() {
    const modal = document.createElement('div');
    modal.className = 'modal-content destination-picker';
    modal.innerHTML = `
      <div class="modal-header">
        <h2>Meal destination</h2>
        <button class="modal-close" id="destination-close" aria-label="Close">✕</button>
      </div>
      <label class="control-group"><span class="control-label">Date</span>
        <input type="date" class="form-input" id="destination-date" value="${targetDate}">
      </label>
      <label class="control-group"><span class="control-label">Meal</span>
        <select class="meal-type-select" id="destination-meal">
          ${MEAL_TYPES.map(type => `<option value="${type.toLowerCase()}" ${type === mealType ? 'selected' : ''}>${type}</option>`).join('')}
        </select>
      </label>
      <p class="setting-hint">Every item in this draft will be saved to this meal.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="destination-cancel">Cancel</button>
        <button class="btn btn-primary" id="destination-apply">Apply</button>
      </div>
    `;
    let destinationInProgress = false;
    const dialog = openModal(modal, { canClose: () => !destinationInProgress });
    const applyButton = dialog.querySelector('#destination-apply');
    const modalControls = [...dialog.querySelectorAll('button, input, select')];
    dialog.querySelector('#destination-close')?.addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
    dialog.querySelector('#destination-cancel')?.addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
    applyButton?.addEventListener('click', async () => {
      if (destinationInProgress) return;
      const nextDate = dialog.querySelector('#destination-date')?.value;
      if (!isCalendarDate(nextDate)) {
        showToast('Choose a valid date');
        return;
      }
      const previousDate = targetDate;
      const previousMealType = mealType;
      targetDate = nextDate;
      const nextMeal = dialog.querySelector('#destination-meal')?.value;
      mealType = MEAL_TYPES.find(type => type.toLowerCase() === nextMeal) || 'Lunch';
      destinationInProgress = true;
      modalControls.forEach(control => { control.disabled = true; });
      applyButton.textContent = 'Applying…';
      if (!await persistDraft()) {
        targetDate = previousDate;
        mealType = previousMealType;
        destinationInProgress = false;
        modalControls.forEach(control => { control.disabled = false; });
        applyButton.textContent = 'Apply';
        return;
      }
      closeModal({ target: dialog, force: true, reason: 'completed' });
    });
  }

  function renderFamiliarMeals() {
    if (!familiarMeals.length) return '';
    return `
      <section class="search-section familiar-meals-section">
        <h3 class="section-title">Familiar meals</h3>
        <div class="familiar-meal-list">
          ${familiarMeals.map((template, index) => `
            <button class="familiar-meal-chip" data-familiar-index="${index}">
              <span>${escapeHTML(template.name)}</span>
              <small>${template.items.length} item${template.items.length === 1 ? '' : 's'}</small>
            </button>
          `).join('')}
        </div>
      </section>
    `;
  }

  function bindFamiliarMealEvents() {
    document.querySelectorAll('.familiar-meal-chip').forEach(button => {
      button.addEventListener('click', async () => {
        const mutationGeneration = captureDataMutationGeneration();
        const template = familiarMeals[Number(button.dataset.familiarIndex)];
        if (!template?.items?.length) return;
        button.disabled = true;
        const additions = [];
        for (const mealItem of template.items) {
          const food = await getById('foods', mealItem.foodId);
          additions.push(createDraftItemFromMealItem(mealItem, food, {
            inputMethod: 'familiar meal',
          }));
        }
        if (!await persistDraft(
          { ...draft, items: [...draft.items, ...additions] },
          { mutationGeneration },
        )) {
          button.disabled = false;
          return;
        }
        showToast(`Added ${template.name} to the draft`);
        button.disabled = false;
      });
    });
  }

  function basisFoodForItem(item) {
    const basis = item.basisSnapshot;
    return {
      ...(item.foodSnapshot || {}),
      id: item.foodId,
      name: item.nameSnapshot,
      servingSize: {
        quantity: basis.quantity,
        unit: basis.unit,
        gramsPerUnit: basis.gramsPerUnit,
        aliases: basis.aliases || [],
        label: basis.label || null,
        packageQuantity: basis.packageQuantity,
        packageUnit: basis.packageUnit,
      },
    };
  }

  function renderDraftReviewContent({ focusIndex = null, focusField = null } = {}) {
    if (!activeReviewModal) return;
    const totals = getDraftTotals(draft);
    activeReviewModal.innerHTML = `
      <div class="modal-header">
        <div><h2 id="${draftReviewTitleId}">Review ${mealType}</h2><p class="modal-subtitle">${formatDate(targetDate)}</p></div>
        <button class="modal-close" id="draft-review-close" aria-label="Close" ${saveInProgress ? 'disabled' : ''}>✕</button>
      </div>
      <div class="draft-review-list">
        ${draft.items.map((item, index) => {
          const units = getUnitsForFood(basisFoodForItem(item));
          if (!units.some(candidate => candidate.value === item.unit)) {
            units.unshift({ value: item.unit, label: item.unit });
          }
          const source = item.provenance?.nutritionSource || 'Saved food';
          const method = item.provenance?.inputMethod || 'added';
          const assumptions = item.provenance?.assumptions || [];
          const servingReference = item.basisSnapshot?.label;
          return `
            <article class="draft-review-item" data-draft-item="${escapeHTML(item.draftItemId)}">
              <div class="draft-review-heading">
                <div>
                  <h3>${escapeHTML(item.nameSnapshot)}</h3>
                  <div class="draft-provenance">
                    <span>${escapeHTML(source)}</span><span>${escapeHTML(method)}</span>
                    ${item.provenance?.adjusted ? '<span>Adjusted</span>' : ''}
                  </div>
                </div>
                <button class="draft-remove-btn" data-remove-index="${index}" aria-label="Remove ${escapeHTML(item.nameSnapshot)}" ${saveInProgress ? 'disabled' : ''}>Remove</button>
              </div>
              ${servingReference ? `<p class="serving-reference">Serving reference: ${escapeHTML(servingReference)}</p>` : ''}
              <div class="draft-review-controls">
                <label><span class="control-label">Quantity</span><input type="number" min="0.01" max="10000" step="0.1" class="form-input draft-item-quantity" data-item-index="${index}" value="${item.quantity}" ${saveInProgress ? 'disabled' : ''}></label>
                <label><span class="control-label">Unit</span><select class="unit-select draft-item-unit" data-item-index="${index}" ${saveInProgress ? 'disabled' : ''}>${units.map(unit => `<option value="${escapeHTML(unit.value)}" ${unit.value === item.unit ? 'selected' : ''}>${escapeHTML(unit.label)}</option>`).join('')}</select></label>
                <div class="draft-item-nutrition"><strong>${Number.isFinite(item.nutrients?.kcal) ? `${Math.round(item.nutrients.kcal)} kcal` : 'Calories unknown'}</strong><span>${Number.isFinite(item.nutrients?.protein) ? `${item.nutrients.protein.toFixed(1)}g protein` : 'Protein unknown'}</span></div>
              </div>
              ${assumptions.length ? `<details class="ai-assumptions"><summary>Estimate assumptions</summary><ul>${assumptions.map(assumption => `<li>${escapeHTML(assumption)}</li>`).join('')}</ul></details>` : ''}
            </article>
          `;
        }).join('') || '<p class="search-empty">This draft is empty.</p>'}
      </div>
      <div class="draft-review-totals" aria-live="polite">
        <span><strong>${totals.incomplete.includes('kcal') ? '—' : totals.kcal}</strong> kcal</span>
        <span><strong>${totals.incomplete.includes('protein') ? '—' : `${totals.protein}g`}</strong> protein</span>
        <span>${totals.incomplete.includes('carbs') ? '—' : `${totals.carbs}g`} carbs</span>
        <span>${totals.incomplete.includes('fat') ? '—' : `${totals.fat}g`} fat</span>
      </div>
      ${totals.incomplete.length ? `<p class="draft-partial-data" role="note">Some foods do not include ${totals.incomplete.map(escapeHTML).join(', ')}. Missing values are shown as unknown, not zero.</p>` : ''}
      <div class="draft-discard-row">
        <button class="btn ${discardConfirming ? 'btn-danger' : 'btn-ghost'} btn-small" id="draft-discard" ${saveInProgress ? 'disabled' : ''}>${discardConfirming ? 'Confirm discard' : 'Discard draft'}</button>
        ${discardConfirming ? '<span role="status">This removes the unfinished draft from this device.</span>' : ''}
      </div>
      <label class="familiar-meal-save"><input type="checkbox" id="save-familiar-meal" ${saveFamiliarSelected ? 'checked' : ''} ${saveInProgress ? 'disabled' : ''}> Save as a familiar meal</label>
      <label class="control-group familiar-meal-name ${saveFamiliarSelected ? '' : 'hidden'}" id="familiar-meal-name-group"><span class="control-label">Meal name</span><input class="form-input" id="familiar-meal-name" maxlength="120" placeholder="e.g., Weekday lunch" value="${escapeHTML(familiarMealName)}" ${saveInProgress ? 'disabled' : ''}></label>
      <div class="modal-actions draft-review-actions">
        <button class="btn btn-secondary" id="draft-keep-adding" ${saveInProgress ? 'disabled' : ''}>Keep adding</button>
        <button class="btn btn-primary" id="draft-save-meal" ${draft.items.length === 0 || saveInProgress ? 'disabled' : ''}>${saveInProgress ? 'Saving…' : 'Save meal'}</button>
      </div>
    `;

    document.getElementById('draft-review-close')?.addEventListener('click', closeDraftReview);
    document.getElementById('draft-keep-adding')?.addEventListener('click', closeDraftReview);
    document.getElementById('save-familiar-meal')?.addEventListener('change', event => {
      saveFamiliarSelected = event.target.checked;
      document.getElementById('familiar-meal-name-group')?.classList.toggle('hidden', !event.target.checked);
      if (event.target.checked) document.getElementById('familiar-meal-name')?.focus();
    });
    document.getElementById('familiar-meal-name')?.addEventListener('input', event => {
      familiarMealName = event.target.value;
    });
    document.getElementById('draft-discard')?.addEventListener('click', async () => {
      if (saveInProgress) return;
      if (!discardConfirming) {
        discardConfirming = true;
        renderDraftReviewContent();
        document.getElementById('draft-discard')?.focus();
        return;
      }
      if (!await clearAddDraftIfCurrentLocked(draft, {
        mutationGeneration: pageMutationGeneration,
      })) {
        showToast('This draft changed in another tab and was not discarded. Reload Add Food.', 'error', 7000);
        return;
      }
      draft = loadAddDraft({ date: targetDate, mealType: mealType.toLowerCase() });
      discardConfirming = false;
      closeDraftReview();
      renderDraftTray();
      showToast('Draft discarded');
    });
    document.querySelectorAll('.draft-remove-btn').forEach(button => {
      button.addEventListener('click', async () => {
        if (saveInProgress) return;
        const removeIndex = Number(button.dataset.removeIndex);
        const nextItems = draft.items.filter((_, index) => index !== removeIndex);
        if (!await persistDraft({ ...draft, items: nextItems })) return;
        const nextIndex = Math.min(removeIndex, draft.items.length - 1);
        renderDraftReviewContent({ focusIndex: nextIndex >= 0 ? nextIndex : null, focusField: 'quantity' });
      });
    });
    document.querySelectorAll('.draft-item-quantity').forEach(input => {
      input.addEventListener('change', () => updateReviewItem(Number(input.dataset.itemIndex), { quantity: Number(input.value) }, 'quantity'));
    });
    document.querySelectorAll('.draft-item-unit').forEach(select => {
      select.addEventListener('change', () => updateReviewItem(Number(select.dataset.itemIndex), { unit: select.value }, 'unit'));
    });
    document.getElementById('draft-save-meal')?.addEventListener('click', saveDraftMeal);
    if (focusIndex != null) {
      queueMicrotask(() => {
        const selector = focusField === 'unit' ? '.draft-item-unit' : '.draft-item-quantity';
        activeReviewModal?.querySelector(`${selector}[data-item-index="${focusIndex}"]`)?.focus();
      });
    }
  }

  async function updateReviewItem(index, updates, focusField) {
    if (saveInProgress) return;
    try {
      const nextItems = [...draft.items];
      nextItems[index] = updateDraftItem(nextItems[index], updates);
      if (!await persistDraft({ ...draft, items: nextItems })) return;
      renderDraftReviewContent({ focusIndex: index, focusField });
    } catch {
      showToast('Enter a quantity greater than zero');
      renderDraftReviewContent({ focusIndex: index, focusField });
    }
  }

  function openDraftReview() {
    if (!draft.items.length) return;
    saveFamiliarSelected = false;
    familiarMealName = '';
    discardConfirming = false;
    const source = document.createElement('div');
    source.className = 'modal-content draft-review-modal';
    activeReviewModal = source;
    renderDraftReviewContent();
    activeReviewModal = openModal(source, {
      canClose: () => !saveInProgress,
      onClose: () => { activeReviewModal = null; },
    });
    // openModal moves the source children into its connected wrapper.
    // Render once more so listener queries bind to the visible dialog.
    renderDraftReviewContent();
    activeReviewModal.setAttribute('aria-labelledby', draftReviewTitleId);
  }

  function closeDraftReview() {
    const dialog = activeReviewModal;
    if (dialog && closeModal({ target: dialog, reason: 'draft-review-close' })) activeReviewModal = null;
  }

  async function saveDraftMeal() {
    if (saveInProgress || !draft.items.length) return;
    if (!isAddDraftCurrent(draft)) {
      showToast('This draft changed in another tab. Reload Add Food before saving.', 'error', 7000);
      return;
    }
    const saveFamiliar = saveFamiliarSelected;
    const familiarName = familiarMealName.trim();
    if (saveFamiliar && !familiarName) {
      showToast('Name the familiar meal first');
      document.getElementById('familiar-meal-name')?.focus();
      return;
    }

    saveInProgress = true;
    renderDraftReviewContent();
    const reviewDialog = activeReviewModal;
    const savedDraft = structuredClone(draft);
    const saveCommandKey = savedDraft.idempotencyKey;
    const items = savedDraft.items.map(toMealItem);
    let result;
    let draftStillCurrent = false;
    let draftCleared = false;
    let familiarSaveFailed = false;
    try {
      const relatedFoodEntries = await Promise.all(savedDraft.items.map(async item => {
        if (!item.foodSnapshot) return null;
        const existing = await getById('foods', item.foodId);
        // A familiar meal's snapshot is its calculation basis, not a request
        // to roll an existing catalog food back to historical nutrition.
        if (existing && item.provenance?.inputMethod === 'familiar meal') return null;
        return item.foodSnapshot;
      }));
      const relatedFoods = [...new Map(relatedFoodEntries
        .filter(Boolean)
        .map(food => [food.id, food])).values()];
      const lockedResult = await withAddDraftLock(async (_draftLockToken, mutationGuardToken) => {
        if (!isAddDraftCurrent(savedDraft)) {
          const conflict = new Error('The draft changed before it could be saved');
          conflict.code = 'DRAFT_CONFLICT';
          throw conflict;
        }
        const mealResult = await createMeal({
          date: savedDraft.date,
          type: savedDraft.mealType,
          items,
          createdAt: new Date().toISOString(),
        }, {
          idempotencyKey: saveCommandKey,
          relatedFoods,
          catalogPreferences: [...new Map(savedDraft.items
            .filter(item => item.catalogPreferences)
            .map(item => [item.foodId, { foodId: item.foodId, ...item.catalogPreferences }])).values()],
          mutationGuardToken,
          mutationGeneration: pageMutationGeneration,
        });
        if (!mealMatchesDraft(mealResult.meal, savedDraft, items)) {
          const mismatch = new Error('An earlier version of this draft was already saved');
          mismatch.code = 'DRAFT_REPLAY_MISMATCH';
          throw mismatch;
        }
        const stillCurrent = isAddDraftCurrent(savedDraft);
        let familiarFailed = false;
        if (saveFamiliar) {
          try {
            const templateKey = `template_${createDeterministicKey('familiar', saveCommandKey)}`;
            await put('settings', {
              key: templateKey,
              value: {
                kind: 'meal',
                name: familiarName,
                mealType: savedDraft.mealType,
                items,
                createdAt: savedDraft.updatedAt || new Date().toISOString(),
              },
            }, {
              mutationGuardToken,
              mutationGeneration: pageMutationGeneration,
            });
          } catch (error) {
            familiarFailed = true;
            console.error('Familiar meal save failed:', error);
          }
        }
        return {
          result: mealResult,
          draftStillCurrent: stillCurrent,
          draftCleared: stillCurrent && clearAddDraftIfCurrent(savedDraft),
          familiarSaveFailed: familiarFailed,
        };
      }, undefined, { mutationGeneration: pageMutationGeneration });
      ({ result, draftStillCurrent, draftCleared, familiarSaveFailed } = lockedResult);
    } catch (error) {
      console.error('Meal draft save failed:', error);
      const message = error?.code === 'DRAFT_REPLAY_MISMATCH'
        ? 'An earlier version of this draft is already in Diary. This newer draft was kept; remove the earlier meal before saving it.'
        : error?.code === 'DRAFT_CONFLICT'
          ? 'This draft changed in another tab. Reload Add Food before saving.'
          : 'Meal was not saved. Your draft is still here.';
      showToast(message, 'error', 8000);
      saveInProgress = false;
      renderDraftReviewContent();
      return;
    }

    // Everything below runs only after the meal transaction has committed.
    // Local UI cleanup and the optional reusable template cannot turn that
    // confirmed write into a false "not saved" result.
    draft = loadAddDraft({
      storage: draftCleared ? undefined : null,
      date: targetDate,
      mealType: mealType.toLowerCase(),
    });
    closeModal({ target: reviewDialog, force: true, reason: 'saved' });
    if (activeReviewModal === reviewDialog) activeReviewModal = null;
    renderDraftTray();

    const undoMutationGeneration = captureDataMutationGeneration();
    showUndoToast(`Saved ${items.length} item${items.length === 1 ? '' : 's'} to ${mealType}`, async () => {
      let restoredDraft;
      try {
        restoredDraft = await withAddDraftLock(async (_draftLockToken, mutationGuardToken) => {
          const restored = restoreAddDraftIfVacant(savedDraft);
          if (!restored) return null;
          // Keep the meal removal in the same critical section so another tab
          // cannot consume and clear the restored draft before Undo finishes.
          await softDelete('meals', result.meal.id, {
            mutationGuardToken,
            mutationGeneration: undoMutationGeneration,
          });
          return restored;
        }, undefined, { mutationGeneration: undoMutationGeneration });
      } catch (error) {
        console.error('Meal undo failed:', error);
        showToast('The draft was restored, but the saved meal could not be removed.', 'error', 7000);
        return;
      }
      if (!restoredDraft) {
        showToast('Undo stopped because another draft is already in progress.', 'error', 7000);
        return;
      }
      draft = restoredDraft;
      targetDate = draft.date;
      mealType = MEAL_TYPES.find(type => type.toLowerCase() === draft.mealType) || 'Lunch';
      window.location.hash = `#/search?date=${targetDate}&meal=${draft.mealType}`;
    }, 7000);
    if (!draftCleared && draftStillCurrent) {
      showToast('Meal saved, but this browser could not clear its local draft. Repeat saves are protected.', 'error', 7000);
    } else if (!draftStillCurrent) {
      showToast('Meal saved. A newer draft from another tab was kept.', 'error', 7000);
    }
    if (familiarSaveFailed) {
      showToast('Meal saved, but the familiar meal copy could not be saved.', 'error', 6000);
    }
    window.location.hash = `#/diary?date=${targetDate}`;
  }

  // ===== SEARCH MODE =====
  async function renderSearchMode(el, renderSequence) {
    const recentFoods = await getRecentFoods();
    const frequentFoods = await getFavoriteFoods();
    if (disposed || mode !== 'search' || renderSequence !== modeRenderSequence || !el.isConnected) return;

    el.innerHTML = `
      <div class="search-input-row">
        <div class="search-input-wrapper">
          <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" class="search-input" id="food-search-input" placeholder="Search foods..." autocomplete="off" aria-label="Search for foods" role="searchbox" value="${escapeHTML(searchQuery)}">
        </div>
        <button class="search-filter-btn ${(!searchSources.local || !searchSources.usda || !searchSources.off) ? 'has-filter' : ''}" id="filter-toggle-btn" aria-label="Filter sources" aria-expanded="false">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        </button>
      </div>
      <div class="search-source-filters hidden" id="source-filters" role="group" aria-label="Filter by source">
        <button class="source-filter-chip ${searchSources.local ? 'active' : ''}" data-source="local" aria-pressed="${searchSources.local}">Local</button>
        <button class="source-filter-chip ${searchSources.usda ? 'active' : ''}" data-source="usda" aria-pressed="${searchSources.usda}">USDA</button>
        <button class="source-filter-chip ${searchSources.off ? 'active' : ''}" data-source="off" aria-pressed="${searchSources.off}">OFF</button>
      </div>
      <div id="search-results-area">
        ${renderFamiliarMeals()}
        ${recentFoods.length > 0 ? `<section class="search-section"><h3 class="section-title">Recent Foods</h3><div class="food-results">${recentFoods.map(f => renderFoodResult(f)).join('')}</div></section>` : ''}
        ${frequentFoods.length > 0 ? `<section class="search-section"><h3 class="section-title">Frequent Foods</h3><div class="food-results">${frequentFoods.map(f => renderFoodResult(f)).join('')}</div></section>` : ''}
        ${recentFoods.length === 0 && frequentFoods.length === 0 ? '<div class="search-empty"><p>Search for foods to log</p></div>' : ''}
        <div class="search-actions"><button class="btn btn-outline" id="add-custom-food-btn">Add Custom Food</button></div>
      </div>
    `;

    const searchInput = document.getElementById('food-search-input');
    searchInput.focus();
    bindFoodResultEvents([...recentFoods, ...frequentFoods], 'searched');
    bindFamiliarMealEvents();
    document.getElementById('add-custom-food-btn')?.addEventListener('click', () => openCustomFoodForm({
      onAdd: addFoodToDraft,
      isActive: () => !disposed && container.isConnected,
    }));
    if (!preselectedHandled && params.get('foodId')) {
      preselectedHandled = true;
      const mutationGeneration = captureDataMutationGeneration();
      const preselectedFood = await getById('foods', params.get('foodId'));
      if (disposed || mode !== 'search' || renderSequence !== modeRenderSequence || !el.isConnected) return;
      if (preselectedFood) openPortionModal(preselectedFood, {
        onAdd: addFoodToDraft,
        inputMethod: 'recent',
        mutationGeneration,
      });
    }
    if (searchQuery) {
      if (searchResults.length) {
        renderSearchResults(document.getElementById('search-results-area'), searchResults, { status: lastSearchStatus });
      } else {
        performTextSearch();
      }
    }

    // Filter toggle
    const filterBtn = document.getElementById('filter-toggle-btn');
    const filterPanel = document.getElementById('source-filters');
    filterBtn?.addEventListener('click', () => {
      const open = filterPanel.classList.toggle('hidden');
      filterBtn.setAttribute('aria-expanded', !open);
    });

    // Source filter chips
    document.querySelectorAll('.source-filter-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const source = chip.dataset.source;
        if (source !== 'local' && !searchSources[source]) {
          const consent = await requestFoodSourceConsent(source);
          if (!consent) return;
        }
        searchSources[source] = !searchSources[source];
        if (!searchSources.local && !searchSources.usda && !searchSources.off) {
          searchSources[source] = true;
          return;
        }
        chip.classList.toggle('active', searchSources[source]);
        chip.setAttribute('aria-pressed', String(searchSources[source]));
        filterBtn.classList.toggle('has-filter', !searchSources.local || !searchSources.usda || !searchSources.off);
        offPage = 1;
        usdaPage = 1;
        if (searchQuery) performTextSearch();
      });
    });

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      clearTimeout(searchTimeout);
      if (!searchQuery) {
        searchSequence++;
        renderModeContent();
        return;
      }
      offPage = 1;
      usdaPage = 1;
      // Auto-detect barcode
      if (/^\d{8,13}$/.test(searchQuery)) {
        performBarcodeLookup(searchQuery); return;
      }
      searchTimeout = setTimeout(() => performTextSearch(), 300);
    });
  }

  async function performTextSearch(loadMore = false) {
    if (loadMore && loadMoreInProgress) return;
    const area = document.getElementById('search-results-area');
    if (!area) return;
    if (loadMore) loadMoreInProgress = true;
    const requestedQuery = searchQuery;
    const requestedOffPage = loadMore && searchSources.off ? offPage + 1 : offPage;
    const requestedUsdaPage = loadMore && searchSources.usda ? usdaPage + 1 : usdaPage;
    const sequence = ++searchSequence;
    searchAbortController?.abort();
    searchAbortController = new AbortController();
    const { signal } = searchAbortController;
    if (!loadMore) {
      area.innerHTML = '<div class="search-loading">Searching...</div>';
    }
    try {
      if (!loadMore && searchSources.local) {
        const localResults = await searchFoods(requestedQuery, {
          localOnly: true,
          limit: 50,
          sources: { local: true, usda: false, off: false },
        });
        if (sequence !== searchSequence || requestedQuery !== searchQuery || disposed || mode !== 'search' || !area.isConnected) return;
        if (localResults.length > 0) {
          searchResults = localResults;
          renderSearchResults(area, searchResults, {
            loadingRemote: searchSources.usda || searchSources.off,
          });
        }
      }

      const { foods: newResults, status } = await searchFoodsWithStatus(requestedQuery, {
        localOnly: false,
        limit: 50,
        sources: loadMore ? { ...searchSources, local: false } : searchSources,
        offPage: requestedOffPage,
        usdaPage: requestedUsdaPage,
        signal,
      });
      if (sequence !== searchSequence || requestedQuery !== searchQuery || disposed || mode !== 'search' || !area.isConnected) return;
      lastSearchStatus = status;
      if (loadMore) {
        if (searchSources.off) offPage = requestedOffPage;
        if (searchSources.usda) usdaPage = requestedUsdaPage;
        const unique = new Map();
        for (const food of [...searchResults, ...newResults]) {
          const identity = food.id || `${food.source?.type || 'food'}:${food.barcode?.ean13 || food.name}`;
          if (!unique.has(identity)) unique.set(identity, food);
        }
        searchResults = [...unique.values()];
      } else {
        searchResults = newResults;
      }
      if (!searchResults?.length) {
        area.innerHTML = `${renderSearchSourceStatus(status)}<div class="search-empty"><p>No foods found for "${escapeHTML(searchQuery)}"</p></div><div class="search-actions"><button class="btn btn-outline" id="add-custom-food-btn">Add Custom Food</button></div>`;
        bindSearchSourceStatusEvents();
        document.getElementById('add-custom-food-btn')?.addEventListener('click', () => openCustomFoodForm({
          onAdd: addFoodToDraft,
          isActive: () => !disposed && container.isConnected,
        }));
        return;
      }
      renderSearchResults(area, searchResults, { status });
    } catch (err) {
      if (signal.aborted || sequence !== searchSequence || requestedQuery !== searchQuery || disposed || mode !== 'search' || !area.isConnected) return;
      console.error('Search error:', err);
      if (loadMore && searchResults.length) {
        showToast('Could not load more foods. Try again.', 'error');
        renderSearchResults(area, searchResults, { status: lastSearchStatus });
      } else {
        area.innerHTML = '<div class="search-error"><p>Search failed. Please try again.</p></div>';
      }
    } finally {
      if (loadMore) loadMoreInProgress = false;
    }
  }

  function renderSearchSourceStatus(status) {
    const failed = Object.entries(status || {})
      .filter(([, detail]) => detail?.state === 'error');
    if (!failed.length) return '';
    const names = failed.map(([source]) => source === 'off' ? 'Open Food Facts' : source === 'usda' ? 'USDA' : source);
    const needsSetup = failed.some(([, detail]) => detail?.code === 'not-configured');
    return `
      <div class="search-source-status" role="status">
        <p><strong>${escapeHTML(names.join(' and '))} ${needsSetup ? 'needs setup.' : 'unavailable.'}</strong> ${needsSetup ? 'Add its API key in Settings, or keep using foods on this device.' : 'Showing results already on this device.'}</p>
        <div>
          ${needsSetup ? '<a class="btn btn-outline btn-small" href="#/settings">Open Settings</a>' : '<button class="btn btn-outline btn-small" id="search-source-retry">Retry</button>'}
          <button class="btn btn-ghost btn-small" id="search-local-only">Use local only</button>
        </div>
      </div>
    `;
  }

  function bindSearchSourceStatusEvents() {
    document.getElementById('search-source-retry')?.addEventListener('click', () => performTextSearch());
    document.getElementById('search-local-only')?.addEventListener('click', () => {
      searchSources = { local: true, usda: false, off: false };
      document.querySelectorAll('.source-filter-chip').forEach(chip => {
        const enabled = Boolean(searchSources[chip.dataset.source]);
        chip.classList.toggle('active', enabled);
        chip.setAttribute('aria-pressed', String(enabled));
      });
      document.getElementById('filter-toggle-btn')?.classList.add('has-filter');
      performTextSearch();
    });
  }

  function renderSearchResults(area, foods, { loadingRemote = false, status = null } = {}) {
    const hasRemoteSources = searchSources.usda || searchSources.off;
    const loadingStatus = loadingRemote
      ? '<p class="search-loading" role="status">Showing local matches while food databases load…</p>'
      : '';
    const loadMoreBtn = hasRemoteSources && !loadingRemote
      ? '<button class="btn btn-outline" id="load-more-btn">Load More</button>'
      : '';
    area.innerHTML = `${renderSearchSourceStatus(status)}${loadingStatus}<section class="search-section"><h3 class="section-title">Results</h3><div class="food-results">${foods.map(f => renderFoodResult(f)).join('')}</div></section><div class="search-actions">${loadMoreBtn}<button class="btn btn-outline" id="add-custom-food-btn">Add Custom Food</button></div>`;
    bindSearchSourceStatusEvents();
    bindFoodResultEvents(foods, 'searched');
    document.getElementById('add-custom-food-btn')?.addEventListener('click', () => openCustomFoodForm({
      onAdd: addFoodToDraft,
      isActive: () => !disposed && container.isConnected,
    }));
    document.getElementById('load-more-btn')?.addEventListener('click', () => {
      const button = document.getElementById('load-more-btn');
      if (button) {
        button.disabled = true;
        button.textContent = 'Loading…';
      }
      performTextSearch(true);
    });
  }

  async function performBarcodeLookup(code) {
    const area = document.getElementById('search-results-area');
    if (!area) return;
    const requestedCode = String(code);
    const sequence = ++searchSequence;
    searchAbortController?.abort();
    searchBarcodeAbortController?.abort();
    searchBarcodeAbortController = new AbortController();
    const { signal } = searchBarcodeAbortController;
    const isCurrent = () => sequence === searchSequence
      && requestedCode === searchQuery
      && !disposed
      && mode === 'search'
      && area.isConnected;
    const localFood = await findLocalBarcodeFood(code);
    if (!isCurrent()) return;
    if (localFood) {
      area.innerHTML = `<section class="search-section"><h3 class="section-title">Saved Barcode Match</h3><div class="food-results">${renderFoodResult(localFood)}</div></section>`;
      bindFoodResultEvents([localFood], 'scanned');
      return;
    }
    const consent = await requestFoodSourceConsent('off');
    if (!isCurrent()) return;
    if (!consent) {
      area.innerHTML = '<div class="search-empty"><p>Remote barcode lookup is off. Local foods remain available.</p></div>';
      return;
    }
    area.innerHTML = '<div class="search-loading">Looking up barcode...</div>';
    try {
      const food = await lookupBarcode(code, { signal, throwOnError: true });
      if (!isCurrent()) return;
      if (!food) { area.innerHTML = `<div class="search-empty"><p>Barcode <strong>${escapeHTML(code)}</strong> not found</p></div>`; return; }
      area.innerHTML = `<section class="search-section"><h3 class="section-title">Barcode Match</h3><div class="food-results">${renderFoodResult(food)}</div></section>`;
      bindFoodResultEvents([food], 'scanned');
    } catch (err) {
      if (signal.aborted || !isCurrent()) return;
      area.innerHTML = renderBarcodeFailure(err, 'search-barcode-retry');
      document.getElementById('search-barcode-retry')?.addEventListener('click', () => performBarcodeLookup(code));
    }
  }

  // ===== SCAN MODE =====
  function renderScanMode(el) {
    el.innerHTML = `
      <div class="scan-mode">
        <div class="scanner-camera-container" id="scanner-container">
          <div id="scanner-viewport" style="width:100%;height:100%"></div>
          <div class="scanner-reticle" id="scanner-reticle" style="display:none"></div>
        </div>
        <div class="scanner-controls">
          <button class="btn btn-primary btn-small" id="start-camera-btn">Start Camera</button>
          <button class="btn btn-secondary btn-small" id="stop-camera-btn" style="display:none">Stop Camera</button>
        </div>
        <div class="scanner-or-divider">or enter barcode manually</div>
        <div class="scan-manual-input">
          <input type="text" class="search-input" id="barcode-manual-input" placeholder="Enter barcode number..." inputmode="numeric" aria-label="Barcode number">
          <button class="btn btn-primary btn-small" id="barcode-lookup-btn">Look Up</button>
        </div>
        <div id="scan-result"></div>
      </div>
    `;

    document.getElementById('start-camera-btn')?.addEventListener('click', startCamera);
    document.getElementById('stop-camera-btn')?.addEventListener('click', stopScanner);
    document.getElementById('barcode-lookup-btn')?.addEventListener('click', () => {
      const code = document.getElementById('barcode-manual-input')?.value.trim();
      if (code) handleBarcodeResult(code);
    });
    document.getElementById('barcode-manual-input')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const code = e.target.value.trim();
        if (code) handleBarcodeResult(code);
      }
    });
  }

  async function startCamera() {
    const generation = ++cameraStartGeneration;
    const Q = await loadQuagga();
    if (generation !== cameraStartGeneration || disposed || mode !== 'scan') return;
    if (!Q) { showToast('Camera scanning not available'); return; }
    const viewport = document.getElementById('scanner-viewport');
    const startButton = document.getElementById('start-camera-btn');
    const stopButton = document.getElementById('stop-camera-btn');
    const reticle = document.getElementById('scanner-reticle');
    if (!viewport || !startButton || !stopButton || !reticle) return;
    startButton.style.display = 'none';
    stopButton.style.display = '';
    reticle.style.display = '';

    try {
      await new Promise((res, rej) => {
        Q.init({ inputStream: { type: 'LiveStream', target: viewport, constraints: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } } }, decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'] }, locate: true, frequency: 10 }, err => err ? rej(err) : res());
      });
      if (generation !== cameraStartGeneration || disposed || mode !== 'scan') {
        try { Q.stop(); } catch {}
        return;
      }
      Q.start();
      cameraStarted = true;
      scannerDetectionHandler = result => {
        const code = result?.codeResult?.code;
        if (code) { stopScanner(); handleBarcodeResult(code); }
      };
      Q.onDetected(scannerDetectionHandler);
    } catch (err) {
      if (generation !== cameraStartGeneration || disposed || mode !== 'scan') return;
      console.error('Camera error:', err);
      showToast('Could not access camera');
      stopScanner();
    }
  }

  function stopScanner() {
    cameraStartGeneration++;
    if (Quagga && scannerDetectionHandler && typeof Quagga.offDetected === 'function') {
      try { Quagga.offDetected(scannerDetectionHandler); } catch {}
    }
    scannerDetectionHandler = null;
    if (Quagga) { try { Quagga.stop(); } catch {} }
    cameraStarted = false;
    const startBtn = document.getElementById('start-camera-btn');
    const stopBtn = document.getElementById('stop-camera-btn');
    const reticle = document.getElementById('scanner-reticle');
    if (startBtn) startBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
    if (reticle) reticle.style.display = 'none';
  }

  async function handleBarcodeResult(code) {
    const resultDiv = document.getElementById('scan-result');
    if (!resultDiv) return;
    const sequence = ++scanLookupSequence;
    scanBarcodeAbortController?.abort();
    scanBarcodeAbortController = new AbortController();
    const { signal } = scanBarcodeAbortController;
    const isCurrent = () => sequence === scanLookupSequence
      && !disposed
      && mode === 'scan'
      && resultDiv.isConnected;
    const localFood = await findLocalBarcodeFood(code);
    if (!isCurrent()) return;
    if (localFood) {
      resultDiv.innerHTML = `<div class="food-results">${renderFoodResult(localFood)}</div>`;
      bindFoodResultEvents([localFood], 'scanned');
      return;
    }
    const consent = await requestFoodSourceConsent('off');
    if (!isCurrent()) return;
    if (!consent) {
      resultDiv.innerHTML = '<div class="search-empty"><p>Remote barcode lookup is off.</p></div>';
      return;
    }
    resultDiv.innerHTML = '<div class="search-loading">Looking up barcode...</div>';
    try {
      const food = await lookupBarcode(code, { signal, throwOnError: true });
      if (!isCurrent()) return;
      if (!food) { resultDiv.innerHTML = `<div class="search-empty"><p>Barcode <strong>${escapeHTML(code)}</strong> not found</p></div>`; return; }
      resultDiv.innerHTML = `<div class="food-results">${renderFoodResult(food)}</div>`;
      bindFoodResultEvents([food], 'scanned');
    } catch (error) {
      if (signal.aborted || !isCurrent()) return;
      resultDiv.innerHTML = renderBarcodeFailure(error, 'scan-barcode-retry');
      document.getElementById('scan-barcode-retry')?.addEventListener('click', () => handleBarcodeResult(code));
    }
  }

  async function findLocalBarcodeFood(code) {
    const normalized = String(code || '').trim();
    if (!normalized) return null;
    const foods = await getAll('foods');
    return foods.find(food => String(food.barcode?.ean13 || food.barcode || '').trim() === normalized) || null;
  }

  function renderBarcodeFailure(error, retryId) {
    const reason = error?.code === 'timeout'
      ? 'The barcode service timed out.'
      : error?.code === 'consent-required'
        ? 'Remote barcode lookup is off.'
        : 'The barcode service is unavailable.';
    return `
      <div class="search-source-status" role="alert">
        <p><strong>${reason}</strong> You can search foods already on this device or try again.</p>
        <div><button class="btn btn-outline btn-small" id="${retryId}">Retry</button></div>
      </div>
    `;
  }

  // ===== UNIFIED AI MODE =====
  function renderAIMode(el) {
    if (aiProcessing) { el.innerHTML = renderAIProcessing(aiAttachedPhoto ? 'photo' : 'description'); return; }
    if (clarificationData?.questions?.length) { el.innerHTML = renderClarificationUI(); wireClarificationEvents(); return; }
    if (aiResults) { el.innerHTML = renderAIResults(); wireAIResultEvents(); return; }

    const browserSpeechAvailable = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    const mediaCaptureAvailable = Boolean(
      navigator.mediaDevices?.getUserMedia
      && window.MediaRecorder
      && (window.AudioContext || window.webkitAudioContext),
    );
    const voiceAvailable = mediaCaptureAvailable && (aiProvider === 'openai' || browserSpeechAvailable);

    el.innerHTML = `
      <div class="ai-unified-input">
        ${aiAttachedPhoto ? `
          <div class="ai-attached-photo">
            <img src="${aiAttachedPhoto}" alt="Attached meal photo">
            <button class="ai-photo-remove" id="ai-remove-photo" aria-label="Remove photo">&#10005;</button>
          </div>
        ` : ''}
        <textarea class="ai-text-area" id="ai-text-input" rows="3" maxlength="2000" placeholder="Describe what you ate, attach a photo, or both..." aria-label="Describe your meal">${escapeHTML(aiTextValue)}</textarea>
        <div class="ai-input-actions">
          <button class="btn btn-secondary btn-small" id="ai-photo-btn" aria-label="Attach photo">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            Photo
          </button>
          <button class="btn btn-secondary btn-small ${isRecording ? 'recording' : ''}" id="ai-voice-btn" aria-label="${isRecording ? 'Stop recording' : voiceAvailable ? 'Record voice' : 'Voice unavailable in this browser'}" ${voiceAvailable ? '' : 'disabled'}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="${isRecording ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                ${isRecording ? '<rect x="6" y="6" width="12" height="12" rx="2"/>' : '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>'}
              </svg>
              ${isRecording ? 'Stop' : voiceAvailable ? 'Voice' : 'Voice unavailable'}
          </button>
          <button class="btn btn-primary btn-small" id="ai-submit-btn">Analyze</button>
        </div>
        ${isRecording ? `<div class="ai-recording-indicator"><div class="waveform-bars" id="voice-waveform">${Array(12).fill('<div class="waveform-bar"></div>').join('')}</div><p class="ai-voice-hint">Listening... tap Stop when done</p></div>` : ''}
        <input type="file" id="ai-photo-capture" accept="image/*" capture="environment" style="display:none">
        <input type="file" id="ai-photo-gallery" accept="image/*" style="display:none">
        <div class="ai-disclaimer"><p>AI estimates are not exact. Review before confirming.</p></div>
      </div>
      ${renderFamiliarMeals()}
    `;
    bindFamiliarMealEvents();

    // Photo attachment
    document.getElementById('ai-photo-btn')?.addEventListener('click', () => {
      // On mobile, offer camera; on desktop, just gallery
      if (/Mobi|Android/i.test(navigator.userAgent)) {
        document.getElementById('ai-photo-capture')?.click();
      } else {
        document.getElementById('ai-photo-gallery')?.click();
      }
    });
    document.getElementById('ai-photo-capture')?.addEventListener('change', e => handlePhotoAttach(e));
    document.getElementById('ai-photo-gallery')?.addEventListener('change', e => handlePhotoAttach(e));
    document.getElementById('ai-remove-photo')?.addEventListener('click', () => {
      aiAttachedPhoto = null;
      renderModeContent();
    });

    // Voice recording
    document.getElementById('ai-voice-btn')?.addEventListener('click', () => {
      isRecording ? stopVoiceTranscription() : startVoiceTranscription();
    });

    // Submit
    document.getElementById('ai-submit-btn')?.addEventListener('click', processAIInput);
    document.getElementById('ai-text-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) processAIInput();
    });

    // Persist textarea value on input
    document.getElementById('ai-text-input')?.addEventListener('input', (e) => {
      aiTextValue = e.target.value;
    });

    // Waveform animation
    if (isRecording) {
      amplitudeInterval = setInterval(() => {
        if (!recorder) return;
        const amp = recorder.getAmplitude();
        document.querySelectorAll('.waveform-bar').forEach(bar => { bar.style.height = `${Math.max(4, amp * 100 * (0.5 + Math.random() * 0.5))}%`; });
      }, 100);
    }
  }

  async function handlePhotoAttach(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Choose an image file');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      showToast('Choose an image smaller than 15 MB');
      return;
    }
    aiAttachedPhoto = await fileToDataUrl(file);
    renderModeContent();
  }

  async function startVoiceTranscription() {
    const generation = ++voiceStartGeneration;
    try {
      if (aiProvider !== 'openai') {
        const consent = await requestPrivacyConsent({
          key: 'browser_speech',
          title: 'Use browser speech recognition?',
          message: 'Your browser or operating system may send microphone audio to its speech service. LibreLog then sends the transcript to your configured AI provider. Your diary history is not sent.',
          confirmLabel: 'Use Voice Input',
        });
        if (!consent || generation !== voiceStartGeneration || disposed || mode !== 'ai') return;
      }
      const vp = await loadVoiceParser();
      if (!vp || generation !== voiceStartGeneration || disposed || mode !== 'ai') return;
      const pendingRecorder = await vp.startRecording();
      if (generation !== voiceStartGeneration || disposed || mode !== 'ai') {
        try { pendingRecorder?.cancel(); } catch {}
        return;
      }
      recorder = pendingRecorder;
      isRecording = true;
      renderModeContent();
    } catch {
      if (generation === voiceStartGeneration && !disposed && mode === 'ai') {
        showToast('Could not access microphone');
        isRecording = false;
      }
    }
  }

  async function stopVoiceTranscription() {
    voiceStartGeneration++;
    if (amplitudeInterval) clearInterval(amplitudeInterval);
    amplitudeInterval = null;
    isRecording = false;
    if (!recorder) return;
    try {
      const vp = await loadVoiceParser();
      const { blob, liveTranscript } = await recorder.stop();
      recorder = null;
      const transcription = await vp.transcribeAudio(blob, liveTranscript);
      if (transcription.text) {
        aiTextValue = aiTextValue ? `${aiTextValue} ${transcription.text}` : transcription.text;
        aiInputMethod = 'spoken';
      } else {
        showToast(transcription.error || 'Could not transcribe');
      }
    } catch { showToast('Voice transcription failed'); }
    renderModeContent();
  }

  async function processAIInput() {
    if (aiProcessing) return;
    const text = document.getElementById('ai-text-input')?.value.trim() || '';
    if (!text && !aiAttachedPhoto) { showToast('Add a photo or describe your meal'); return; }
    if (aiAttachedPhoto) aiInputMethod = 'photo';
    else if (aiInputMethod !== 'spoken') aiInputMethod = 'typed';
    const mutationGeneration = captureDataMutationGeneration();
    aiProcessing = true;
    aiResults = null;
    renderModeContent();
    const ai = await loadAI();
    if (!ai || !(await ai.isAIConfigured())) {
      aiProcessing = false;
      renderModeContent();
      showToast('Set up an AI provider in Settings first');
      return;
    }
    aiAbortController?.abort();
    aiAbortController = new AbortController();
    const { signal } = aiAbortController;
    try {
      if (aiAttachedPhoto) {
        // Photo mode (with optional text context)
        const proc = await loadImageProcessor();
        const result = await proc.analyzeImage(aiAttachedPhoto, text, {
          signal,
          mutationGeneration,
        });
        if (signal.aborted || disposed) return;
        aiResults = result.success ? result : { foods: [], error: result.error };
      } else {
        // Text-only mode
        const vp = await loadVoiceParser();
        const parsed = await vp.parseTranscription(text, { signal, mutationGeneration });
        if (signal.aborted || disposed) return;
        aiResults = parsed.success ? parsed : { foods: [], error: parsed.error };
      }
      aiSelected = new Set((aiResults?.foods || []).map((_, index) => index));
      if (aiResults?.foods?.length) await checkClarification(signal, mutationGeneration);
    } catch {
      if (!signal.aborted) aiResults = { foods: [], error: 'AI analysis failed' };
    }
    if (signal.aborted || disposed) return;
    aiProcessing = false;
    aiAbortController = null;
    aiTextValue = '';
    aiAttachedPhoto = null;
    renderModeContent();
  }

  function stopVoice() {
    voiceStartGeneration++;
    if (amplitudeInterval) clearInterval(amplitudeInterval);
    amplitudeInterval = null;
    isRecording = false;
    if (recorder) { try { recorder.cancel(); } catch {} recorder = null; }
  }

  // ===== CLARIFICATION =====
  async function checkClarification(signal, mutationGeneration) {
    const engine = await loadClarification();
    if (!engine) {
      clarificationData = null;
      return;
    }
    if (!engine.needsClarification(aiResults.foods)) {
      clarificationData = null;
      return;
    }
    try {
      clarificationData = await engine.generateClarifications(aiResults.foods, [], {
        signal,
        mutationGeneration,
      });
      if (!clarificationData?.questions?.length) clarificationData = null;
    } catch {
      clarificationData = null;
    }
  }

  function renderClarificationUI() {
    const questions = clarificationData.questions;
    return `
      <div class="clarify-container">
        <p class="clarify-header">A few quick questions to improve accuracy:</p>
        ${questions.map((q, qi) => {
          const food = aiResults.foods[q.foodIndex];
          const foodName = food ? escapeHTML(food.name) : 'Unknown';
          return `
            <div class="clarify-card" data-question-index="${qi}">
              <div class="clarify-question">${escapeHTML(q.question)}</div>
              <div class="clarify-food-context">${foodName}</div>
              <div class="clarify-options">
                ${q.options.map((opt, oi) => `
                  <button class="clarify-option ${oi === 0 ? 'selected' : ''}" data-question="${qi}" data-option="${oi}" aria-pressed="${oi === 0}">${escapeHTML(opt.label)}</button>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
        <div class="clarify-actions">
          <button class="btn btn-secondary" id="clarify-skip-btn">Skip</button>
          <button class="btn btn-primary" id="clarify-done-btn">Done</button>
        </div>
      </div>
    `;
  }

  function wireClarificationEvents() {
    // Option selection
    document.querySelectorAll('.clarify-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const qi = btn.dataset.question;
        document.querySelectorAll(`.clarify-option[data-question="${qi}"]`).forEach(b => {
          b.classList.remove('selected');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');
      });
    });

    // Skip — go to results with original data
    document.getElementById('clarify-skip-btn')?.addEventListener('click', () => {
      clarificationData = null;
      renderModeContent();
    });

    // Done — apply refinements and show results
    document.getElementById('clarify-done-btn')?.addEventListener('click', async () => {
      const engine = await loadClarification();
      if (!engine) { clarificationData = null; renderModeContent(); return; }

      for (const q of clarificationData.questions) {
        const selectedBtn = document.querySelector(`.clarify-option[data-question="${clarificationData.questions.indexOf(q)}"].selected`);
        if (!selectedBtn) continue;
        const optIdx = parseInt(selectedBtn.dataset.option);
        const option = q.options[optIdx];
        if (option) {
          aiResults.foods = engine.applyRefinement(aiResults.foods, q.foodIndex, option);
        }
      }

      clarificationData = null;
      renderModeContent();
    });
  }

  // ===== SHARED AI RESULTS =====
  function renderAIProcessing(type) {
    return `<div class="ai-processing"><div class="ai-spinner"></div><p>Analyzing your ${type === 'photo' ? 'photo' : type === 'voice' ? 'recording' : 'description'}...</p></div>`;
  }

  function renderAIResults() {
    if (!aiResults?.foods?.length) {
      return `<div class="ai-no-results"><p>${aiResults?.error ? escapeHTML(aiResults.error) : 'No foods identified.'}</p><button class="btn btn-primary" id="ai-retry-btn">Try Again</button></div>`;
    }
    const foods = aiResults.foods;
    return `
      <div class="ai-results">
        <h3 class="ai-results-title">Detected Foods</h3>
        ${aiResults.processingTime ? `<p class="ai-results-time">Analyzed in ${(aiResults.processingTime / 1000).toFixed(1)}s</p>` : ''}
        <div class="ai-food-list">
          ${foods.map((food, i) => {
            const qty = food._draftQuantity ?? food.servingSize?.quantity ?? 100;
            const unit = food._draftUnit || food.servingSize?.unit || 'g';
            const preview = createDraftItem(food, { quantity: qty, unit, inputMethod: aiInputMethod });
            const kcal = preview.nutrients?.kcal || 0;
            const p = preview.nutrients?.protein || 0;
            const c = preview.nutrients?.carbs || 0;
            const f = preview.nutrients?.fat || 0;
            const nutritionAvailable = Number.isFinite(preview.nutrients?.kcal);
            const units = getUnitsForFood(food);
            if (!units.some(candidate => candidate.value === unit)) {
              units.unshift({ value: unit, label: unit });
            }
            const assumptions = food._aiMeta?.assumptions || [];
            return `<div class="ai-food-item" data-ai-food-index="${i}">
              <div class="ai-food-row">
              <input type="checkbox" class="ai-food-check" data-index="${i}" ${aiSelected.has(i) ? 'checked' : ''} aria-label="Add ${escapeHTML(food.name)} to draft">
              <div class="ai-food-info">
                <label><span class="sr-only">Food name</span><input class="form-input ai-food-edit" data-index="${i}" data-field="name" value="${escapeHTML(food.name)}"></label>
                <div class="form-row">
                  <label><span class="sr-only">Quantity</span><input type="number" min="0.01" max="10000" step="0.1" class="form-input ai-food-edit" data-index="${i}" data-field="quantity" value="${qty}"></label>
                  <label><span class="sr-only">Unit</span><select class="form-input ai-food-edit" data-index="${i}" data-field="unit">${units.map(candidate => `<option value="${escapeHTML(candidate.value)}" ${candidate.value === unit ? 'selected' : ''}>${escapeHTML(candidate.label)}</option>`).join('')}</select></label>
                </div>
              </div>
              <div class="ai-food-nutrition">${nutritionAvailable ? `<span class="ai-food-kcal">${Math.round(kcal)} kcal</span><span class="ai-food-macros">${Math.round(p)}P ${Math.round(c)}C ${Math.round(f)}F</span>` : '<span class="ai-portion-error" role="alert">Choose a compatible unit</span>'}</div>
              <span class="source-badge ai">AI estimate</span>
              </div>
              <div class="form-row ai-nutrition-edit">
                ${[['calories', kcal], ['protein', p], ['carbs', c], ['fat', f]].map(([field, value]) => `<label><span class="control-label">${field === 'calories' ? 'kcal' : field}</span><input type="number" min="0" step="0.1" class="form-input ai-food-edit" data-index="${i}" data-field="${field}" value="${value}"></label>`).join('')}
              </div>
              ${assumptions.length ? `<details class="ai-assumptions"><summary>Estimate assumptions</summary><ul>${assumptions.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></details>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div class="ai-results-actions">
          <button class="btn btn-secondary" id="ai-retry-btn">Retry</button>
          <button class="btn btn-primary" id="ai-confirm-btn">Add selected (${aiSelected.size})</button>
        </div>
      </div>
    `;
  }

  function refreshAIFoodResultRow(index) {
    const food = aiResults?.foods?.[index];
    const row = document.querySelector(`.ai-food-item[data-ai-food-index="${index}"]`);
    if (!food || !row) return;

    const quantity = food._draftQuantity ?? food.servingSize?.quantity ?? 100;
    const unit = food._draftUnit || food.servingSize?.unit || 'g';
    const preview = createDraftItem(food, { quantity, unit, inputMethod: aiInputMethod });
    const values = {
      quantity,
      calories: preview.nutrients?.kcal ?? 0,
      protein: preview.nutrients?.protein ?? 0,
      carbs: preview.nutrients?.carbs ?? 0,
      fat: preview.nutrients?.fat ?? 0,
    };

    for (const [field, value] of Object.entries(values)) {
      const input = row.querySelector(`.ai-food-edit[data-field="${field}"]`);
      if (input) input.value = value;
    }
    const nameInput = row.querySelector('.ai-food-edit[data-field="name"]');
    if (nameInput) nameInput.value = food.name;
    const unitSelect = row.querySelector('.ai-food-edit[data-field="unit"]');
    if (unitSelect) unitSelect.value = unit;
    row.querySelector('.ai-food-check')?.setAttribute('aria-label', `Add ${food.name} to draft`);

    const nutrition = row.querySelector('.ai-food-nutrition');
    if (!nutrition) return;
    if (!Number.isFinite(preview.nutrients?.kcal)) {
      nutrition.innerHTML = '<span class="ai-portion-error" role="alert">Choose a compatible unit</span>';
      return;
    }
    nutrition.innerHTML = '<span class="ai-food-kcal"></span><span class="ai-food-macros"></span>';
    nutrition.querySelector('.ai-food-kcal').textContent = `${Math.round(values.calories)} kcal`;
    nutrition.querySelector('.ai-food-macros').textContent = `${Math.round(values.protein)}P ${Math.round(values.carbs)}C ${Math.round(values.fat)}F`;
  }

  function wireAIResultEvents() {
    document.getElementById('ai-retry-btn')?.addEventListener('click', () => {
      aiResults = null;
      aiSelected.clear();
      aiInputMethod = 'typed';
      renderModeContent();
    });
    document.querySelectorAll('.ai-food-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const index = Number(cb.dataset.index);
        if (cb.checked) aiSelected.add(index);
        else aiSelected.delete(index);
        const btn = document.getElementById('ai-confirm-btn');
        if (btn) btn.textContent = `Add selected (${aiSelected.size})`;
      });
    });
    document.querySelectorAll('.ai-food-edit').forEach(input => {
      input.addEventListener('change', () => {
        const index = Number(input.dataset.index);
        let food = aiResults.foods[index];
        if (!food) return;
        const field = input.dataset.field;
        const numericFields = new Set(['quantity', 'calories', 'protein', 'carbs', 'fat']);
        const value = numericFields.has(field) ? Number(input.value) : input.value.trim();
        const invalidNumber = numericFields.has(field) && (
          !Number.isFinite(value)
          || (field === 'quantity' ? value <= 0 || value > 10000 : value < 0)
        );
        if (invalidNumber) {
          input.setAttribute('aria-invalid', 'true');
          showToast(field === 'quantity'
            ? 'Enter a quantity greater than zero'
            : 'Enter a valid non-negative number');
          return;
        }
        input.removeAttribute('aria-invalid');
        if (field === 'name') food.name = value || 'Food estimate';
        if (field === 'quantity') food._draftQuantity = value;
        if (field === 'unit') food._draftUnit = value || food.servingSize?.unit || 'g';
        if (['calories', 'protein', 'carbs', 'fat'].includes(field)) {
          const nutrientKey = field === 'calories' ? 'kcal' : field;
          try {
            food = rebaseFoodNutritionForPortion(food, {
              quantity: food._draftQuantity ?? food.servingSize?.quantity ?? 100,
              unit: food._draftUnit || food.servingSize?.unit || 'g',
              nutrients: { [nutrientKey]: value },
            });
            aiResults.foods[index] = food;
          } catch {
            input.setAttribute('aria-invalid', 'true');
            showToast('Choose a compatible unit before editing nutrition');
            return;
          }
        }
        food._aiMeta = { ...(food._aiMeta || {}), edited: true };
        refreshAIFoodResultRow(index);
      });
    });
    document.getElementById('ai-confirm-btn')?.addEventListener('click', confirmAIFoods);
  }

  async function confirmAIFoods() {
    if (!aiResults?.foods) return;
    const selected = [...aiSelected].sort((a, b) => a - b);
    if (selected.length === 0) { showToast('Select at least one food'); return; }
    const invalidInput = [...document.querySelectorAll('.ai-food-edit[aria-invalid="true"]')]
      .find(input => aiSelected.has(Number(input.dataset.index)));
    if (invalidInput) {
      showToast('Correct the highlighted estimate before adding it');
      invalidInput.focus();
      return;
    }
    const additions = [];
    for (const index of selected) {
      const food = aiResults.foods[index];
      if (!food) continue;
      const item = createDraftItem(food, {
        name: food.name,
        quantity: food._draftQuantity ?? food.servingSize?.quantity ?? 100,
        unit: food._draftUnit || food.servingSize?.unit || 'g',
        notes: 'AI estimate',
        inputMethod: aiInputMethod,
        assumptions: food._aiMeta?.assumptions || [],
        adjusted: Boolean(food._aiMeta?.edited),
      });
      if (!Number.isFinite(item.nutrients?.kcal)) {
        showToast(`Choose a compatible serving unit for ${food.name}.`, 'error');
        return;
      }
      additions.push(item);
    }
    if (!await persistDraft(
      { ...draft, items: [...draft.items, ...additions] },
      { mutationGeneration: aiResults.mutationGeneration },
    )) return;
    const count = additions.length;
    aiResults = null;
    aiSelected.clear();
    aiInputMethod = 'typed';
    renderModeContent();
    showToast(`Added ${count} estimate${count === 1 ? '' : 's'} to the draft`);
  }

  // ===== SHARED HELPERS =====
  function bindFoodResultEvents(foods, inputMethod = 'searched') {
    document.querySelectorAll('.food-result-item').forEach(el => {
      const handler = async () => {
        const mutationGeneration = captureDataMutationGeneration();
        const foodId = el.dataset.foodId;
        const food = foods.find(f => f.id === foodId) || await getById('foods', foodId);
        if (food) openPortionModal(food, {
          onAdd: addFoodToDraft,
          inputMethod,
          mutationGeneration,
        });
      };
      el.addEventListener('click', handler);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
    });
  }

  async function addFoodToDraft(food, {
    quantity,
    unit,
    notes,
    inputMethod = 'searched',
    catalogPreferences = null,
    mutationGeneration = pageMutationGeneration,
  }) {
    if (!await persistDraft(
      {
        ...draft,
        items: [...draft.items, createDraftItem(food, {
          quantity,
          unit,
          notes,
          inputMethod,
          catalogPreferences,
        })],
      },
      { mutationGeneration },
    )) {
      const error = new Error('Draft persistence failed');
      error.code = 'DRAFT_PERSIST_FAILED';
      throw error;
    }
    showToast(`${food.name} added to the draft`);
  }

  await render();
  // Cleanup on navigate away
  return () => {
    disposed = true;
    modeRenderSequence++;
    scanLookupSequence++;
    aiAbortController?.abort();
    aiAbortController = null;
    searchAbortController?.abort();
    searchAbortController = null;
    searchBarcodeAbortController?.abort();
    searchBarcodeAbortController = null;
    scanBarcodeAbortController?.abort();
    scanBarcodeAbortController = null;
    searchSequence++;
    clearTimeout(searchTimeout);
    stopScanner();
    stopVoice();
  };
}

function requestFoodSourceConsent(source) {
  if (source === 'usda') {
    return requestPrivacyConsent({
      key: 'usda',
      title: 'Use USDA FoodData Central?',
      message: 'LibreLog sends food search terms and food identifiers to USDA FoodData Central. LibreLog does not send your diary history.',
      confirmLabel: 'Use USDA Search',
    });
  }
  return requestPrivacyConsent({
    key: 'openfoodfacts',
    title: 'Use Open Food Facts?',
    message: 'LibreLog sends food search terms and barcodes to Open Food Facts. LibreLog does not send your diary history.',
    confirmLabel: 'Use Open Food Facts',
  });
}

// ===== STANDALONE FUNCTIONS =====
function renderFoodResult(food) {
  const protein = food.nutrients?.macros?.protein?.g;
  const carbs = food.nutrients?.macros?.carbs?.g;
  const fat = food.nutrients?.macros?.fat?.g;
  const kcal = food.nutrients?.energy?.kcal;
  const nutrient = (value, suffix) => value != null && Number.isFinite(Number(value)) ? `${Math.round(Number(value))}${suffix}` : `—${suffix}`;
  const macroSummary = `${nutrient(protein, 'P')} ${nutrient(carbs, 'C')} ${nutrient(fat, 'F')}`;
  const calorieSummary = kcal != null && Number.isFinite(Number(kcal)) ? `${Math.round(Number(kcal))} kcal` : 'Calories unknown';
  const accessibleCalorieSummary = kcal != null && Number.isFinite(Number(kcal)) ? `${Math.round(Number(kcal))} calories` : 'calories unknown';
  const servingLabel = getServingDisplayLabel(food);
  const sourceType = typeof food.source?.type === 'string' ? food.source.type : '';
  const sourceClass = {
    openFoodFacts: 'off',
    usda: 'usda',
    local: 'local',
    custom: 'custom',
    seed: 'seed',
    myfitnesspal: 'myfitnesspal',
    'ai-photo': 'ai',
    'ai-voice': 'ai',
    'ai-text': 'ai',
  }[sourceType] || 'other';
  const sourceLabel = sourceType === 'openFoodFacts' ? 'OFF' : sourceType.toUpperCase().slice(0, 24);
  const sourceBadge = sourceType ? `<span class="source-badge ${sourceClass}">${escapeHTML(sourceLabel)}</span>` : '';
  const safeId = escapeHTML(String(food.id || ''));
  const safeServingLabel = escapeHTML(String(servingLabel));
  return `
    <div class="food-result-item" data-food-id="${safeId}" role="button" tabindex="0" aria-label="${escapeHTML(food.name)}, ${escapeHTML(accessibleCalorieSummary)} per ${safeServingLabel}">
      <div class="food-result-info">
        <div class="food-result-name">${escapeHTML(food.name)}</div>
        ${food.brand ? `<div class="food-result-brand">${escapeHTML(food.brand)}</div>` : ''}
        <div class="food-result-meta"><span class="kcal-badge">${escapeHTML(calorieSummary)}/${safeServingLabel}</span><span class="macro-summary">${macroSummary}</span>${sourceBadge}</div>
      </div>
      <div class="food-result-action" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div>
    </div>
  `;
}

function openPortionModal(food, {
  onAdd,
  inputMethod = 'searched',
  mutationGeneration = captureDataMutationGeneration(),
} = {}) {
  const numberOrNull = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  const baseNutrition = {
    calories: numberOrNull(food.nutrients?.energy?.kcal),
    protein: numberOrNull(food.nutrients?.macros?.protein?.g),
    carbs: numberOrNull(food.nutrients?.macros?.carbs?.g),
    fat: numberOrNull(food.nutrients?.macros?.fat?.g),
  };
  let quantity = Number(food.usualServing?.quantity) > 0
    ? Number(food.usualServing.quantity)
    : (Number(food.servingSize?.quantity) > 0 ? Number(food.servingSize.quantity) : 100);
  let unit = food.usualServing?.unit || food.servingSize?.unit || 'g';
  let addInProgress = false;
  const availableUnits = getUnitsForFood(food);
  if (!availableUnits.some(candidate => candidate.value === unit)) {
    availableUnits.unshift({ value: unit, label: unit });
  }
  const servingReference = food.servingSize?.label;

  function updatePreview() {
    const m = getNutritionMultiplierOrNull(quantity, unit, food);
    const display = (value, suffix, precision = 1) => Number.isFinite(value) && m != null
      ? `${(value * m).toFixed(precision)}${suffix}`
      : 'Unknown';
    const preview = dialog?.querySelector('#nutrition-preview');
    if (preview) preview.innerHTML = `<div class="nutrition-preview"><div class="preview-stat"><span class="preview-label">Calories</span><span class="preview-value">${display(baseNutrition.calories, ' kcal', 0)}</span></div><div class="preview-stat"><span class="preview-label">Protein</span><span class="preview-value">${display(baseNutrition.protein, 'g')}</span></div><div class="preview-stat"><span class="preview-label">Carbs</span><span class="preview-value">${display(baseNutrition.carbs, 'g')}</span></div><div class="preview-stat"><span class="preview-label">Fat</span><span class="preview-value">${display(baseNutrition.fat, 'g')}</span></div></div>`;
  }

  const modal = document.createElement('div');
  modal.className = 'modal-content portion-editor';
  modal.innerHTML = `
    <div class="modal-header"><div><h2>${escapeHTML(food.name)}</h2>${food.brand ? `<p class="modal-subtitle">${escapeHTML(food.brand)}</p>` : ''}</div><button class="modal-close" id="modal-close" aria-label="Close">✕</button></div>
    <div class="portion-controls">
      <label class="control-group"><span class="control-label">Quantity</span><div class="quantity-input-group"><button class="qty-btn qty-minus" id="qty-minus" aria-label="Decrease">−</button><input type="number" class="qty-input" id="qty-input" value="${quantity}" min="0.1" step="0.1" aria-label="Quantity"><button class="qty-btn qty-plus" id="qty-plus" aria-label="Increase">+</button></div></label>
      <label class="control-group"><span class="control-label">Unit</span><select class="unit-select" id="unit-select" aria-label="Unit">${availableUnits.map(u => `<option value="${escapeHTML(String(u.value))}" ${u.value === unit ? 'selected' : ''}>${escapeHTML(String(u.label))}</option>`).join('')}</select></label>
    </div>
    ${servingReference ? `<p class="serving-reference">Serving reference: ${escapeHTML(servingReference)}</p>` : ''}
    <div id="nutrition-preview"></div>
    <label class="control-group"><span class="control-label">Notes (optional)</span><input type="text" class="notes-input" id="notes-input" maxlength="500" placeholder="e.g., with milk"></label>
    <label class="control-group"><span><input type="checkbox" id="favorite-food" ${food.favorite ? 'checked' : ''}> Add this food to Favorites</span></label>
    <label class="control-group"><span><input type="checkbox" id="save-usual-serving" ${food.usualServing ? 'checked' : ''}> Save this quantity and unit as my usual serving</span></label>
    <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button><button class="btn btn-primary" id="add-to-draft-btn">Add to draft</button></div>
  `;
  const dialog = openModal(modal, { canClose: () => !addInProgress });
  const qtyInput = dialog.querySelector('#qty-input');
  const addButton = dialog.querySelector('#add-to-draft-btn');
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
  qtyInput.addEventListener('input', () => {
    const next = readPositiveNumberInput(qtyInput, { report: false });
    quantity = next ?? NaN;
    updatePreview();
  });
  dialog.querySelector('#unit-select')?.addEventListener('change', (e) => { unit = e.target.value; updatePreview(); });
  dialog.querySelector('#modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
  dialog.querySelector('#cancel-btn').addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
  addButton.addEventListener('click', async () => {
    if (addInProgress) return;
    const nextQuantity = readPositiveNumberInput(qtyInput, { report: true });
    if (nextQuantity == null) return;
    quantity = nextQuantity;
    addInProgress = true;
    modalControls.forEach(control => { control.disabled = true; });
    addButton.textContent = 'Adding…';
    food.favorite = dialog.querySelector('#favorite-food').checked;
    if (dialog.querySelector('#save-usual-serving').checked) {
      food.usualServing = { quantity, unit };
    } else {
      delete food.usualServing;
    }
    try {
      await onAdd?.(food, {
        quantity,
        unit,
        notes: dialog.querySelector('#notes-input').value,
        inputMethod,
        catalogPreferences: {
          favorite: Boolean(food.favorite),
          usualServing: food.usualServing ? { ...food.usualServing } : null,
        },
        mutationGeneration,
      });
      closeModal({ target: dialog, force: true, reason: 'completed' });
    } catch (error) {
      console.error('Could not add food to draft:', error);
      if (error?.code !== 'DRAFT_PERSIST_FAILED') showToast('Could not add food to the draft');
      addInProgress = false;
      modalControls.forEach(control => { control.disabled = false; });
      addButton.textContent = 'Add to draft';
    }
  });
  updatePreview();
}

function openCustomFoodForm({ onAdd, isActive = () => true } = {}) {
  const mutationGeneration = captureDataMutationGeneration();
  const modal = document.createElement('div');
  modal.className = 'modal-content custom-food-form';
  modal.innerHTML = `
    <div class="modal-header"><h2>Add food from a label</h2><button class="modal-close" id="modal-close" aria-label="Close">✕</button></div>
    <div class="form-row"><label class="form-group"><span class="control-label">Food name</span><input type="text" id="custom-name" maxlength="120" placeholder="e.g., Granola" class="form-input"></label><label class="form-group"><span class="control-label">Brand (optional)</span><input type="text" id="custom-brand" maxlength="120" class="form-input"></label></div>
    <label class="form-group"><span class="control-label">Nutrition is for</span><select id="custom-basis" class="form-input"><option value="serving">One serving</option><option value="container">Whole container</option><option value="100g">100 g</option></select></label>
    <div class="custom-basis-details" id="custom-basis-details"></div>
    <p class="custom-nutrition-heading" id="custom-nutrition-heading">Values for one serving</p>
    <div class="form-row"><label class="form-group"><span class="control-label">Calories</span><input type="number" id="custom-kcal" placeholder="0" class="form-input" min="0"></label><label class="form-group"><span class="control-label">Protein (g)</span><input type="number" id="custom-protein" placeholder="0" class="form-input" min="0" step="0.1"></label></div>
    <div class="form-row"><label class="form-group"><span class="control-label">Carbs (g)</span><input type="number" id="custom-carbs" placeholder="0" class="form-input" min="0" step="0.1"></label><label class="form-group"><span class="control-label">Fat (g)</span><input type="number" id="custom-fat" placeholder="0" class="form-input" min="0" step="0.1"></label></div>
    <details class="custom-optional-fields"><summary>More label details</summary>
      <div class="form-row"><label class="form-group"><span class="control-label">Fiber (g)</span><input type="number" id="custom-fiber" class="form-input" min="0" step="0.1"></label><label class="form-group"><span class="control-label">Sodium (mg)</span><input type="number" id="custom-sodium" class="form-input" min="0" step="0.1"></label></div>
      <label class="form-group"><span class="control-label">Barcode (optional)</span><input type="text" id="custom-barcode" class="form-input" inputmode="numeric" maxlength="32"></label>
    </details>
    <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button><button class="btn btn-primary" id="save-btn">Add Food</button></div>
  `;
  let submitted = false;
  const dialog = openModal(modal);

  function renderBasisDetails() {
    const basis = dialog.querySelector('#custom-basis')?.value || 'serving';
    const details = dialog.querySelector('#custom-basis-details');
    const heading = dialog.querySelector('#custom-nutrition-heading');
    if (!details || !heading) return;
    if (basis === '100g') {
      details.innerHTML = '<p class="setting-hint">Enter the values printed per 100 g.</p>';
      heading.textContent = 'Values per 100 g';
      return;
    }
    if (basis === 'container') {
      details.innerHTML = `
        <div class="form-row">
          <label class="form-group"><span class="control-label">Container label</span><input class="form-input" id="custom-serving-label" maxlength="60" value="1 container"></label>
          <label class="form-group"><span class="control-label">Container weight in grams (optional)</span><input type="number" min="0.01" step="0.1" class="form-input" id="custom-grams-per-unit"></label>
        </div>`;
      heading.textContent = 'Values for the whole container';
      return;
    }
    details.innerHTML = `
      <div class="form-row">
        <label class="form-group"><span class="control-label">Serving label</span><input class="form-input" id="custom-serving-label" maxlength="60" value="1 serving" placeholder="e.g., 2 crackers"></label>
        <label class="form-group"><span class="control-label">Serving weight in grams (optional)</span><input type="number" min="0.01" step="0.1" class="form-input" id="custom-grams-per-unit"></label>
      </div>`;
    heading.textContent = 'Values for one serving';
  }

  renderBasisDetails();
  dialog.querySelector('#custom-basis')?.addEventListener('change', renderBasisDetails);
  dialog.querySelector('#modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
  dialog.querySelector('#cancel-btn').addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
  dialog.querySelector('#save-btn').addEventListener('click', () => {
    if (submitted) return;
    const name = dialog.querySelector('#custom-name').value.trim();
    const brand = dialog.querySelector('#custom-brand').value.trim();
    const basis = dialog.querySelector('#custom-basis').value;
    const kcalRaw = dialog.querySelector('#custom-kcal').value.trim();
    const kcal = Number(kcalRaw);
    const readOptionalNumber = id => {
      const raw = dialog.querySelector(`#${id}`).value.trim();
      return raw === '' ? null : Number(raw);
    };
    const protein = readOptionalNumber('custom-protein');
    const carbs = readOptionalNumber('custom-carbs');
    const fat = readOptionalNumber('custom-fat');
    const fiber = readOptionalNumber('custom-fiber');
    const sodium = readOptionalNumber('custom-sodium');
    const barcode = dialog.querySelector('#custom-barcode').value.trim();
    if (!name || kcalRaw === '' || !Number.isFinite(kcal) || kcal < 0) {
      showToast('Enter a food name and non-negative calories');
      return;
    }
    if ([protein, carbs, fat, fiber, sodium].some(value => value !== null && (!Number.isFinite(value) || value < 0))) {
      showToast('Nutrition values cannot be negative');
      return;
    }
    if (barcode && !/^\d{8,14}$/.test(barcode)) {
      showToast('Enter an 8 to 14 digit barcode');
      return;
    }
    const servingLabel = dialog.querySelector('#custom-serving-label')?.value.trim();
    const gramsRaw = dialog.querySelector('#custom-grams-per-unit')?.value.trim() || '';
    const gramsPerUnit = gramsRaw === '' ? null : Number(gramsRaw);
    if (gramsPerUnit !== null && (!Number.isFinite(gramsPerUnit) || gramsPerUnit <= 0)) {
      showToast('Serving weight must be greater than zero');
      return;
    }
    const servingSize = basis === '100g'
      ? { quantity: 100, unit: 'g', label: '100 g', aliases: [] }
      : {
          quantity: 1,
          unit: basis === 'container' ? 'container' : 'serving',
          label: servingLabel || (basis === 'container' ? '1 container' : '1 serving'),
          aliases: [],
          ...(gramsPerUnit !== null ? { gramsPerUnit } : {}),
        };
    const customFood = {
      id: generateId(),
      name,
      brand,
      ...(barcode ? { barcode: { ean13: barcode } } : {}),
      nutrients: {
        energy: { kcal },
        macros: { protein: { g: protein }, carbs: { g: carbs }, fat: { g: fat } },
        fiber: { g: fiber },
        sodium: { mg: sodium },
      },
      servingSize,
      source: { type: 'custom' },
      createdAt: new Date().toISOString(),
    };
    submitted = true;
    closeModal({ target: dialog, reason: 'completed' });
    setTimeout(() => {
      if (isActive()) openPortionModal(customFood, {
        onAdd,
        inputMethod: 'manual',
        mutationGeneration,
      });
    }, 200);
  });
}

function getServingDisplayLabel(food) {
  if (food?.servingSize?.label) return String(food.servingSize.label);
  if (food?.servingSize) return `${food.servingSize.quantity} ${food.servingSize.unit}`;
  return '100 g';
}

function mealMatchesDraft(meal, draft, expectedItems) {
  if (!meal || meal.date !== draft.date || meal.type !== draft.mealType) return false;
  const comparable = item => ({
    foodId: item.foodId,
    nameSnapshot: item.nameSnapshot,
    brandSnapshot: item.brandSnapshot || '',
    quantity: Number(item.quantity),
    unit: item.unit,
    notes: item.notes || '',
    nutrients: item.nutrients,
    basisSnapshot: item.basisSnapshot,
    provenance: item.provenance,
  });
  return JSON.stringify((meal.items || []).map(comparable))
    === JSON.stringify(expectedItems.map(comparable));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}
