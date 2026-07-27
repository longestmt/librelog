import { getAll } from '../data/db.js';
import {
  copyMealsToDate,
  createIdempotencyKey,
} from '../data/meal-commands.js';
import { showToast } from '../components/toast.js';
import { escapeHTML } from '../utils/sanitize.js';
import { formatDate, todayStr } from '../utils/format.js';

export async function renderHistoryPage(container) {
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
      </div>
      <div class="history-controls">
        <label class="setting-input">
          <span class="setting-label">Search History</span>
          <input type="search" id="history-search" placeholder="Food, meal type, or date" autocomplete="off">
        </label>
        <label class="setting-input">
          <span class="setting-label">Log Again On</span>
          <input type="date" id="history-target-date" value="${todayStr()}">
        </label>
      </div>
      <div id="history-results" aria-live="polite"></div>
    </div>
  `;

  const results = document.getElementById('history-results');
  const searchInput = document.getElementById('history-search');
  const targetInput = document.getElementById('history-target-date');

  function itemName(item) {
    return foodsById.get(item.foodId)?.name || 'Unknown food';
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
          const kcal = meal.items.reduce((sum, item) => sum + (Number(item.nutrients?.kcal) || 0), 0);
          const names = meal.items.map(item => escapeHTML(itemName(item))).join(', ');
          return `
            <article class="meal-history-card" role="listitem">
              <div class="meal-history-heading">
                <div>
                  <h2>${escapeHTML(capitalize(meal.type))}</h2>
                  <p>${escapeHTML(formatDate(meal.date))}</p>
                </div>
                <span class="kcal-badge">${Math.round(kcal)} kcal</span>
              </div>
              <p class="meal-history-items">${names}</p>
              <button class="btn btn-outline btn-small history-log-btn" data-meal-id="${escapeHTML(meal.id)}">Log Again</button>
            </article>
          `;
        }).join('')}
      </div>
    `;

    document.querySelectorAll('.history-log-btn').forEach(button => {
      button.addEventListener('click', async event => {
        const actionButton = event.currentTarget;
        const meal = orderedMeals.find(item => item.id === actionButton.dataset.mealId);
        const targetDate = targetInput.value;
        if (!meal || !targetDate) {
          showToast('Select a target date');
          return;
        }
        const commandKeyId = `${meal.id}:${targetDate}`;
        if (!commandKeys.has(commandKeyId)) {
          commandKeys.set(commandKeyId, createIdempotencyKey('history'));
        }
        actionButton.disabled = true;
        try {
          await copyMealsToDate([meal], targetDate, {
            idempotencyKey: commandKeys.get(commandKeyId),
          });
          actionButton.textContent = 'Logged';
          showToast(`Meal logged on ${formatDate(targetDate)}`);
        } catch {
          actionButton.disabled = false;
          showToast('Meal could not be logged. Try again.');
        }
      });
    });
  }

  searchInput.addEventListener('input', renderResults);
  renderResults();
}

function capitalize(value) {
  const text = String(value || 'Meal');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
