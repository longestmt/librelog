import { getAll } from '../data/db.js';
import {
  copyMealsToDate,
  createIdempotencyKey,
} from '../data/meal-commands.js';
import { showToast } from '../components/toast.js';
import { openModal, closeModal } from '../components/modal.js';
import { escapeHTML } from '../utils/sanitize.js';
import { formatDate, todayStr } from '../utils/format.js';
import { captureDataMutationGeneration } from '../data/operation-locks.js';

const isKnownNumber = value => value != null && Number.isFinite(Number(value));

export async function renderHistoryPage(container, queryString) {
  const mutationGeneration = captureDataMutationGeneration();
  const requestedDate = new URLSearchParams(queryString).get('date');
  const targetDate = isCalendarDate(requestedDate) ? requestedDate : todayStr();
  const [meals, foods] = await Promise.all([
    getAll('meals'),
    getAll('foods'),
  ]);
  const foodsById = new Map(foods.map(food => [food.id, food]));
  const orderedMeals = meals
    .filter(meal => Array.isArray(meal.items) && meal.items.length > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date))
      || String(b.createdAt).localeCompare(String(a.createdAt)));
  const commandKeys = new Map();

  container.innerHTML = `
    <div class="history-page">
      <div class="settings-header">
        <h1>Meal History</h1>
        <a class="btn btn-ghost btn-small" href="#/diary?date=${targetDate}">Back to Diary</a>
      </div>
      <div class="history-controls">
        <label class="setting-input">
          <span class="setting-label">Search History</span>
          <input type="search" id="history-search" placeholder="Food, meal type, or date" autocomplete="off">
        </label>
        <label class="setting-input">
          <span class="setting-label">Log Again On</span>
          <input type="date" id="history-target-date" value="${targetDate}">
        </label>
      </div>
      <div id="history-results" aria-live="polite"></div>
    </div>
  `;

  const results = document.getElementById('history-results');
  const searchInput = document.getElementById('history-search');
  const targetInput = document.getElementById('history-target-date');

  function itemName(item) {
    return item.nameSnapshot || foodsById.get(item.foodId)?.name || 'Unknown food';
  }

  function itemSummary(item) {
    const portion = `${item.quantity} ${item.unit || 'serving'}`;
    const reference = item.basisSnapshot?.label;
    return `${itemName(item)} (${reference && reference !== portion ? `${portion} · ${reference}` : portion})`;
  }

  function renderResults() {
    const query = searchInput.value.trim().toLowerCase();
    const visible = orderedMeals.filter(meal => {
      if (!query) return true;
      const text = [
        meal.date,
        meal.type,
        ...meal.items.map(itemName),
      ].join(' ').toLowerCase();
      return text.includes(query);
    });

    if (visible.length === 0) {
      results.innerHTML = '<div class="empty-state"><p>No meals match this search.</p></div>';
      return;
    }

    results.innerHTML = `
      <div class="meal-history-list" role="list">
        ${visible.map(meal => {
          const kcal = meal.items.reduce((sum, item) => {
            const value = item.nutrients?.kcal;
            return sum + (isKnownNumber(value) ? Number(value) : 0);
          }, 0);
          const caloriesIncomplete = meal.items.some(item => !isKnownNumber(item.nutrients?.kcal));
          const names = meal.items.map(item => escapeHTML(itemSummary(item))).join(', ');
          return `
            <article class="meal-history-card" role="listitem">
              <div class="meal-history-heading">
                <div>
                  <h2>${escapeHTML(capitalize(meal.type))}</h2>
                  <p>${escapeHTML(formatDate(meal.date))}</p>
                </div>
                <span class="kcal-badge">${Math.round(kcal)}${caloriesIncomplete ? '+' : ''} kcal${caloriesIncomplete ? ' known' : ''}</span>
              </div>
              <p class="meal-history-items">${names}</p>
              <button class="btn btn-outline btn-small history-log-btn" data-meal-id="${escapeHTML(meal.id)}">Review &amp; Log Again</button>
            </article>
          `;
        }).join('')}
      </div>
    `;

    container.querySelectorAll('.history-log-btn').forEach(button => {
      button.addEventListener('click', event => {
        const actionButton = event.currentTarget;
        const meal = orderedMeals.find(item => item.id === actionButton.dataset.mealId);
        const targetDate = targetInput.value;
        if (!meal || !targetDate) {
          showToast('Select a target date');
          return;
        }
        openLogAgainReview(
          meal,
          targetDate,
          itemSummary,
          commandKeys,
          actionButton,
          mutationGeneration,
        );
      });
    });
  }

  searchInput.addEventListener('input', renderResults);
  renderResults();
}

function openLogAgainReview(
  meal,
  targetDate,
  itemSummary,
  commandKeys,
  actionButton,
  mutationGeneration,
) {
  const calories = meal.items.reduce((sum, item) => {
    const value = item.nutrients?.kcal;
    return sum + (isKnownNumber(value) ? Number(value) : 0);
  }, 0);
  const caloriesIncomplete = meal.items.some(item => !isKnownNumber(item.nutrients?.kcal));
  const modal = document.createElement('div');
  modal.className = 'modal-content';
  modal.innerHTML = `
    <div class="modal-header">
      <h2>Review Meal</h2>
      <button class="modal-close" type="button" aria-label="Close">✕</button>
    </div>
    <p>Log this ${escapeHTML(String(meal.type || 'meal'))} on <strong>${escapeHTML(formatDate(targetDate))}</strong>?</p>
    <ul class="meal-history-review">
      ${meal.items.map(item => `<li>${escapeHTML(itemSummary(item))}<span>${isKnownNumber(item.nutrients?.kcal) ? `${Math.round(Number(item.nutrients.kcal))} kcal` : 'Calories unknown'}</span></li>`).join('')}
    </ul>
    <p><strong>${caloriesIncomplete ? 'Known total' : 'Total'}: ${Math.round(calories)} kcal${caloriesIncomplete ? ' (incomplete)' : ''}</strong></p>
    <div class="modal-actions">
      <button class="btn btn-secondary review-cancel" type="button">Cancel</button>
      <button class="btn btn-primary review-confirm" type="button">Log Meal</button>
    </div>
  `;

  let isSaving = false;
  const dialog = openModal(modal, { canClose: () => !isSaving });
  const modalControls = [...dialog.querySelectorAll('button, input, select')];
  dialog.querySelector('.modal-close').addEventListener('click', () => closeModal({ target: dialog, reason: 'close-button' }));
  dialog.querySelector('.review-cancel').addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
  dialog.querySelector('.review-confirm').addEventListener('click', async event => {
    if (isSaving) return;
    const confirmButton = event.currentTarget;
    const commandKeyId = `${meal.id}:${targetDate}`;
    if (!commandKeys.has(commandKeyId)) {
      commandKeys.set(commandKeyId, createIdempotencyKey('history'));
    }
    isSaving = true;
    modalControls.forEach(control => { control.disabled = true; });
    confirmButton.textContent = 'Logging…';
    try {
      await copyMealsToDate([meal], targetDate, {
        idempotencyKey: commandKeys.get(commandKeyId),
        mutationGeneration,
      });
      commandKeys.delete(commandKeyId);
      closeModal({ target: dialog, force: true, reason: 'saved' });
      actionButton.textContent = 'Review & Log Again';
      showToast(`Meal logged on ${formatDate(targetDate)}`);
    } catch {
      isSaving = false;
      modalControls.forEach(control => { control.disabled = false; });
      confirmButton.textContent = 'Try Again';
      showToast('Meal could not be logged. Try again.', 'error');
    }
  });
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function capitalize(value) {
  const text = String(value || 'Meal');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
