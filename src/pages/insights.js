import { getByIndex, getAll, getById } from '../data/db.js';
import { getGoals } from '../engine/goal-tracking.js';
import { calculateDayTotalsSimple } from '../engine/nutrition.js';
import { todayStr } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { showToast } from '../components/toast.js';

function addDays(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

function formatDateShort(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function renderInsightsPage(container, queryString) {
  let currentView = 'today';

  async function render() {
    container.innerHTML = `
      <div class="insights-page" role="main" aria-label="Nutrition insights">
        <div class="insights-header">
          <h1>Insights</h1>
        </div>

        <div class="tab-selector" role="tablist" aria-label="Time period">
          <button class="tab-btn ${currentView === 'today' ? 'active' : ''}" data-view="today" role="tab" aria-selected="${currentView === 'today'}" aria-controls="insights-content">Today</button>
          <button class="tab-btn ${currentView === 'week' ? 'active' : ''}" data-view="week" role="tab" aria-selected="${currentView === 'week'}" aria-controls="insights-content">This Week</button>
          <button class="tab-btn ${currentView === 'month' ? 'active' : ''}" data-view="month" role="tab" aria-selected="${currentView === 'month'}" aria-controls="insights-content">This Month</button>
        </div>

        <div id="insights-content" class="insights-content" role="tabpanel" aria-label="${currentView} insights">
          <!-- Content rendered based on view -->
        </div>
      </div>
    `;

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        currentView = e.target.dataset.view;
        renderContent();
      });
    });

    renderContent();
  }

  async function renderContent() {
    const activeBtn = document.querySelector('.tab-btn.active');
    if (activeBtn) {
      activeBtn.classList.remove('active');
    }
    document.querySelector(`.tab-btn[data-view="${currentView}"]`)?.classList.add('active');

    switch (currentView) {
      case 'today':
        await renderTodayView();
        break;
      case 'week':
        await renderWeekView();
        break;
      case 'month':
        await renderMonthView();
        break;
    }
  }

  async function renderTodayView() {
    const today = todayStr();
    const meals = await getByIndex('meals', 'date', today) || [];
    const goals = await getGoals();
    const totals = calculateDayTotalsSimple(meals);

    const stats = [
      { label: 'Calories', value: totals.kcal, unit: `/${goals.calorieTarget}`, color: 'calories' },
      { label: 'Protein', value: Math.round(totals.protein), unit: `/${goals.proteinG}g`, color: 'protein' },
      { label: 'Carbs', value: Math.round(totals.carbs), unit: `/${goals.carbG}g`, color: 'carbs' },
      { label: 'Fat', value: Math.round(totals.fat), unit: `/${goals.fatG}g`, color: 'fat' },
    ];

    const caloriesRemaining = Math.max(0, goals.calorieTarget - totals.kcal);
    const caloriesPercent = Math.min(100, (totals.kcal / goals.calorieTarget) * 100);

    const contentDiv = document.getElementById('insights-content');
    contentDiv.innerHTML = `
      <div class="insights-section">
        <h2 class="section-title">Daily Summary</h2>

        <div class="stat-grid">
          ${stats.map(stat => `
            <div class="stat-card stat-card-${stat.color}">
              <div class="stat-label">${stat.label}</div>
              <div class="stat-value">${stat.value}</div>
              <div class="stat-unit">${stat.unit}</div>
            </div>
          `).join('')}
        </div>

        <div class="calorie-progress">
          <div class="progress-header">
            <span class="progress-label">Daily Calorie Target</span>
            <span class="progress-remaining">${caloriesRemaining} remaining</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${caloriesPercent}%"></div>
          </div>
          <div class="progress-text">
            <span>${totals.kcal}</span>
            <span class="text-muted">of ${goals.calorieTarget} kcal</span>
          </div>
        </div>

        ${totals.sodium > (goals.sodiumMg || 2300) ? `
          <div class="alert alert-warning" role="alert">
            <strong>Sodium Alert:</strong> You've exceeded your daily sodium limit (${totals.sodium}mg / ${goals.sodiumMg || 2300}mg). WHO recommends &lt;2000mg/day.
          </div>
        ` : ''}

        ${meals.length > 0 ? `
          <div class="food-breakdown">
            <h3 class="breakdown-title">What You Ate</h3>
            <div class="breakdown-list">
              ${await renderFoodBreakdown(meals)}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  async function renderWeekView() {
    const today = todayStr();
    const weekData = [];
    const goals = await getGoals();

    for (let i = 6; i >= 0; i--) {
      const date = addDays(today, -i);
      const meals = await getByIndex('meals', 'date', date) || [];
      const totals = calculateDayTotalsSimple(meals);
      weekData.push({
        date,
        dayLabel: getDayLabel(date),
        calories: totals.kcal,
      });
    }

    const maxCalories = Math.max(...weekData.map(d => d.calories), goals.calorieTarget);
    const avgCalories = Math.round(weekData.reduce((sum, d) => sum + d.calories, 0) / weekData.length);

    const contentDiv = document.getElementById('insights-content');
    contentDiv.innerHTML = `
      <div class="insights-section">
        <h2 class="section-title">Weekly Summary</h2>

        <div class="week-stats">
          <div class="week-stat">
            <span class="week-stat-label">Average Daily</span>
            <span class="week-stat-value">${avgCalories} kcal</span>
          </div>
          <div class="week-stat">
            <span class="week-stat-label">Target</span>
            <span class="week-stat-value">${goals.calorieTarget} kcal</span>
          </div>
        </div>

        <div class="week-chart">
          <h3 class="chart-title">Calorie History</h3>
          <div class="bar-chart">
            ${weekData.map((day, idx) => {
              const barHeight = (day.calories / maxCalories) * 100;
              const isToday = day.date === today;
              return `
                <div class="bar-column ${isToday ? 'today' : ''}">
                  <div class="bar" style="height: ${barHeight}%"></div>
                  <div class="bar-label">${day.dayLabel}</div>
                  <div class="bar-value">${day.calories}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div class="frequent-foods">
          <h3 class="section-subtitle">Most Logged This Week</h3>
          <div class="frequent-list">
            ${(await getMostFrequentFoods(today, 7)).map(item => `
              <div class="frequent-item">
                <span class="frequent-name">${escapeHTML(item.name)}</span>
                <span class="frequent-count">${item.count}x</span>
              </div>
            `).join('') || '<p class="text-muted">No foods logged</p>'}
          </div>
        </div>
      </div>
    `;
  }

  async function renderMonthView() {
    const today = todayStr();
    const goals = await getGoals();
    const monthData = [];

    for (let i = 29; i >= 0; i--) {
      const date = addDays(today, -i);
      const meals = await getByIndex('meals', 'date', date) || [];
      const totals = calculateDayTotalsSimple(meals);
      monthData.push({
        date,
        calories: totals.kcal,
        hasData: meals.length > 0,
      });
    }

    const loggingStreak = calculateStreak(monthData);
    const avgCalories = Math.round(monthData.reduce((sum, d) => sum + d.calories, 0) / monthData.length);

    const measurements = await getAll('measurements') || [];
    const recentMeasurements = measurements.slice(-3);

    const contentDiv = document.getElementById('insights-content');
    contentDiv.innerHTML = `
      <div class="insights-section">
        <h2 class="section-title">Monthly Summary</h2>

        <div class="month-stats">
          <div class="month-stat">
            <div class="stat-icon">🔥</div>
            <div class="stat-info">
              <span class="stat-label">Logging Streak</span>
              <span class="stat-value">${loggingStreak} days</span>
            </div>
          </div>
          <div class="month-stat">
            <div class="stat-icon">📊</div>
            <div class="stat-info">
              <span class="stat-label">Average Daily</span>
              <span class="stat-value">${avgCalories} kcal</span>
            </div>
          </div>
          <div class="month-stat">
            <div class="stat-icon">📈</div>
            <div class="stat-info">
              <span class="stat-label">Days Logged</span>
              <span class="stat-value">${monthData.filter(d => d.hasData).length}</span>
            </div>
          </div>
        </div>

        <div class="month-heatmap">
          <h3 class="chart-title">Logging Activity</h3>
          <div class="heatmap">
            ${monthData.map(day => `
              <div class="heatmap-day ${day.hasData ? 'active' : ''}" title="${day.date}"></div>
            `).join('')}
          </div>
        </div>

        ${measurements.length > 0 ? `
          <div class="measurements">
            <h3 class="section-subtitle">Weight Trend</h3>
            ${measurements.length >= 2 ? `
              <div class="weight-trend-chart">
                ${renderWeightTrendBars(measurements.slice(-14))}
              </div>
            ` : ''}
            <div class="measurement-list">
              ${recentMeasurements.map(m => `
                <div class="measurement-item">
                  <span class="measurement-date">${formatDateShort(m.date)}</span>
                  <span class="measurement-weight">${m.weight} ${m.unit || 'kg'}</span>
                </div>
              `).join('')}
            </div>
            <a href="#/weight" class="btn btn-outline btn-small" style="margin-top:var(--sp-2)">View All Weight Data</a>
          </div>
        ` : `
          <div class="measurements">
            <h3 class="section-subtitle">Weight Tracking</h3>
            <p class="text-muted">No weight entries yet.</p>
            <a href="#/weight" class="btn btn-outline btn-small" style="margin-top:var(--sp-2)">Start Tracking Weight</a>
          </div>
        `}
      </div>
    `;
  }

  render();
}

function getDayLabel(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
}

function calculateStreak(monthData) {
  let streak = 0;
  for (let i = monthData.length - 1; i >= 0; i--) {
    if (monthData[i].hasData) {
      streak++;
    } else if (streak > 0) {
      break;
    }
  }
  return streak;
}

async function renderFoodBreakdown(meals) {
  const items = [];
  for (const meal of meals) {
    for (const item of (meal.items || [])) {
      const food = await getById('foods', item.foodId);
      const name = food?.name || item.foodId || 'Unknown';
      const kcal = item.nutrients?.kcal || 0;
      items.push(`
        <div class="breakdown-item">
          <span>${escapeHTML(name)}</span>
          <span class="breakdown-kcal">${Math.round(kcal)} kcal</span>
        </div>
      `);
    }
  }
  return items.join('');
}

function renderWeightTrendBars(measurements) {
  if (!measurements || measurements.length === 0) return '';
  const weights = measurements.map(m => m.weight).filter(w => w > 0);
  if (weights.length === 0) return '';
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const range = max - min || 1;

  return `<div class="weight-bars">
    ${measurements.map(m => {
      const pct = ((m.weight - min) / range) * 80 + 20;
      return `<div class="weight-bar-col">
        <div class="weight-bar" style="height:${pct}%"></div>
        <div class="weight-bar-val">${m.weight}</div>
      </div>`;
    }).join('')}
  </div>`;
}

async function getMostFrequentFoods(today, days) {
  const foodCounts = {};

  for (let i = 0; i < days; i++) {
    const date = addDays(today, -i);
    const meals = await getByIndex('meals', 'date', date) || [];
    meals.forEach(meal => {
      (meal.items || []).forEach(item => {
        const name = item.foodId;
        foodCounts[name] = (foodCounts[name] || 0) + 1;
      });
    });
  }

  return Object.entries(foodCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
}
