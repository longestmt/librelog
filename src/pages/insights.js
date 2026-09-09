import { getByIndex, getAll, getById } from '../data/db.js';
import { getGoals } from '../engine/goal-tracking.js';
import { calculateDayTotalsSimple } from '../engine/nutrition.js';
import { createWeightChartModel, prepareWeightData } from '../engine/weight.js';
import { todayStr, addCalendarDays, toLocalDate } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';

function formatDateShort(dateStr) {
  const date = toLocalDate(dateStr);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function summarizeNutritionDays(days, currentDate = todayStr()) {
  const normalizedDays = days.map(day => {
    const hasData = Boolean(day.hasData);
    const status = day.date === currentDate
      ? 'in-progress'
      : (hasData ? 'logged' : 'missing');
    return { ...day, hasData, status };
  });
  const loggedDays = normalizedDays.filter(day => day.status === 'logged');
  const nutrientKey = key => key === 'calories' ? 'kcal' : key;
  const completeDays = key => loggedDays.filter(day => {
    const value = day[key];
    return value !== null
      && value !== ''
      && !day.incomplete?.includes(nutrientKey(key))
      && Number.isFinite(Number(value));
  });
  const average = key => {
    const eligibleDays = completeDays(key);
    return eligibleDays.length
      ? Math.round(eligibleDays.reduce((sum, day) => sum + Number(day[key]), 0) / eligibleDays.length)
      : null;
  };
  const calorieDays = completeDays('calories');
  const proteinDays = completeDays('protein');

  return {
    days: normalizedDays,
    loggedDays,
    averageCalories: average('calories'),
    averageProtein: average('protein'),
    averageCaloriesDays: calorieDays.length,
    averageProteinDays: proteinDays.length,
  };
}

function hasLoggedItems(meals) {
  return meals.some(meal => Array.isArray(meal.items) && meal.items.length > 0);
}

function formatAverage(value, unit, completeDayCount, loggedDayCount) {
  if (value !== null) return `${value} ${unit}`;
  return loggedDayCount > 0 && completeDayCount === 0
    ? 'Not available — values missing'
    : 'No past logged days';
}

function renderAverageCompletenessNote(summary) {
  const exclusions = [];
  if (summary.averageCaloriesDays < summary.loggedDays.length) exclusions.push('calories');
  if (summary.averageProteinDays < summary.loggedDays.length) exclusions.push('protein');
  if (!exclusions.length) return '';
  return `<p class="chart-note">Logged days with unknown ${escapeHTML(exclusions.join(' or '))} are excluded from that nutrient’s average.</p>`;
}

export function renderWeeklyCalorieBars(days, today, maxCalories) {
  const safeMaximum = Number.isFinite(Number(maxCalories)) && Number(maxCalories) > 0
    ? Number(maxCalories)
    : 1;

  return days.map(day => {
    const caloriesUnknown = Boolean(day.hasData && day.incomplete?.includes('kcal'));
    const calories = Number(day.calories);
    const showBar = day.hasData && !caloriesUnknown && Number.isFinite(calories) && calories >= 0;
    const barHeight = showBar ? Math.min(100, (calories / safeMaximum) * 100) : 0;
    const status = [
      caloriesUnknown ? 'Calories unknown' : '',
      day.status === 'in-progress' ? 'In progress' : '',
    ].filter(Boolean).join(' · ');

    return `
      <div class="bar-column ${day.date === today ? 'today' : ''} ${day.status} ${caloriesUnknown ? 'unknown' : ''}">
        ${showBar
          ? `<div class="bar" style="height: ${barHeight}%"></div>`
          : '<div class="bar-gap"></div>'}
        <div class="bar-label">${escapeHTML(day.dayLabel)}</div>
        <div class="bar-value">${showBar ? escapeHTML(day.calories) : '—'}</div>
        ${status ? `<div class="bar-status">${status}</div>` : ''}
      </div>
    `;
  }).join('');
}

export async function renderInsightsPage(container, queryString) {
  let currentView = 'today';
  let contentSequence = 0;
  let disposed = false;

  const isCurrentRender = (view, sequence) => !disposed
    && container.isConnected
    && currentView === view
    && contentSequence === sequence;

  async function render() {
    container.innerHTML = `
      <div class="insights-page">
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

    const tabButtons = [...container.querySelectorAll('.tab-btn')];
    tabButtons.forEach((btn, index) => {
      btn.addEventListener('click', (e) => {
        currentView = e.currentTarget.dataset.view;
        renderContent();
      });
      btn.addEventListener('keydown', (event) => {
        const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home' ? 0
          : event.key === 'End' ? tabButtons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length;
        tabButtons[nextIndex].focus();
        tabButtons[nextIndex].click();
      });
    });

    await renderContent();
  }

  async function renderContent() {
    const requestedView = currentView;
    const sequence = ++contentSequence;
    container.querySelectorAll('.tab-btn').forEach(btn => {
      const selected = btn.dataset.view === requestedView;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    });
    container.querySelector('#insights-content')?.setAttribute('aria-label', `${requestedView} insights`);

    switch (requestedView) {
      case 'today':
        await renderTodayView(sequence);
        break;
      case 'week':
        await renderWeekView(sequence);
        break;
      case 'month':
        await renderMonthView(sequence);
        break;
    }
  }

  async function renderTodayView(sequence) {
    const today = todayStr();
    const meals = await getByIndex('meals', 'date', today) || [];
    const goals = await getGoals();
    const totals = calculateDayTotalsSimple(meals);
    const isIncomplete = key => totals.incomplete?.includes(key);
    const foodBreakdown = meals.length > 0 ? await renderFoodBreakdown(meals) : '';
    if (!isCurrentRender('today', sequence)) return;

    const stats = [
      { key: 'kcal', label: 'Calories', value: totals.kcal, target: goals.calorieTarget, targetUnit: '', color: 'calories' },
      { key: 'protein', label: 'Protein', value: Math.round(totals.protein), target: goals.proteinG, targetUnit: 'g', color: 'protein' },
      { key: 'carbs', label: 'Carbs', value: Math.round(totals.carbs), target: goals.carbG, targetUnit: 'g', color: 'carbs' },
      { key: 'fat', label: 'Fat', value: Math.round(totals.fat), target: goals.fatG, targetUnit: 'g', color: 'fat' },
    ];

    const caloriesRemaining = goals.calorieTarget - totals.kcal;
    const caloriesPercent = Math.min(100, (totals.kcal / goals.calorieTarget) * 100);

    const contentDiv = container.querySelector('#insights-content');
    if (!contentDiv) return;
    contentDiv.innerHTML = `
      <div class="insights-section">
        <h2 class="section-title">Daily Summary</h2>

        <div class="stat-grid">
          ${stats.map(stat => `
            <div class="stat-card stat-card-${stat.color}">
              <div class="stat-label">${stat.label}</div>
              <div class="stat-value">${stat.value}${isIncomplete(stat.key) ? '+' : ''}</div>
              <div class="stat-unit">${formatStatGoal(stat.target, stat.targetUnit, isIncomplete(stat.key))}</div>
            </div>
          `).join('')}
        </div>

        <div class="calorie-progress">
          <div class="progress-header">
            <span class="progress-label">Daily Calorie Target</span>
            <span class="progress-remaining">${isIncomplete('kcal') ? 'Remaining unknown' : caloriesRemaining >= 0 ? `${caloriesRemaining} remaining` : `${Math.abs(caloriesRemaining)} above target`}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${caloriesPercent}%"></div>
          </div>
          <div class="progress-text">
            <span>${totals.kcal}${isIncomplete('kcal') ? '+' : ''}</span>
            <span class="text-muted">${isIncomplete('kcal') ? 'known kcal; target ' : 'of '}${goals.calorieTarget} kcal</span>
          </div>
        </div>

        ${totals.incomplete?.length ? `<p class="nutrition-incomplete-notice" role="note"><strong>Partial nutrition:</strong> some foods do not include ${totals.incomplete.map(escapeHTML).join(', ')}. Known values are marked “+”; missing values are never counted as zero.</p>` : ''}

        ${hasEnabledGoal(goals.sodiumMg) && totals.sodium > goals.sodiumMg ? `
          <div class="alert alert-warning" role="alert">
            <strong>Sodium:</strong> Today’s logged total is above your selected limit (${totals.sodium}mg / ${goals.sodiumMg}mg).
          </div>
        ` : ''}

        ${meals.length > 0 ? `
          <div class="food-breakdown">
            <h3 class="breakdown-title">What You Ate</h3>
            <div class="breakdown-list">
              ${foodBreakdown}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  async function renderWeekView(sequence) {
    const today = todayStr();
    const weekData = [];
    const goals = await getGoals();

    for (let i = 6; i >= 0; i--) {
      const date = addCalendarDays(today, -i);
      const meals = await getByIndex('meals', 'date', date) || [];
      const totals = calculateDayTotalsSimple(meals);
      weekData.push({
        date,
        dayLabel: getDayLabel(date),
        calories: totals.kcal,
        protein: totals.protein,
        incomplete: totals.incomplete,
        hasData: hasLoggedItems(meals),
      });
    }

    const summary = summarizeNutritionDays(weekData, today);
    const maxCalories = Math.max(...summary.days.map(d => d.calories), goals.calorieTarget);
    const frequentFoods = await getMostFrequentFoods(today, 7);
    if (!isCurrentRender('week', sequence)) return;

    const contentDiv = container.querySelector('#insights-content');
    if (!contentDiv) return;
    contentDiv.innerHTML = `
      <div class="insights-section">
        <h2 class="section-title">Weekly Summary</h2>

        <div class="week-stats">
          <div class="week-stat">
            <span class="week-stat-label">Average Logged Day</span>
            <span class="week-stat-value">${formatAverage(summary.averageCalories, 'kcal', summary.averageCaloriesDays, summary.loggedDays.length)}</span>
          </div>
          <div class="week-stat">
            <span class="week-stat-label">Average Protein / Logged Day</span>
            <span class="week-stat-value">${formatAverage(summary.averageProtein, 'g', summary.averageProteinDays, summary.loggedDays.length)}</span>
          </div>
        </div>
        ${renderAverageCompletenessNote(summary)}
        <p class="chart-note">Targets: ${goals.calorieTarget} kcal and ${hasEnabledGoal(goals.proteinG) ? `${goals.proteinG} g protein` : 'protein target disabled'}.</p>

        <div class="week-chart">
          <h3 class="chart-title">Calorie History</h3>
          <p class="chart-note">Missing days are gaps. Today is in progress and excluded from averages; past logged days may still be partial.</p>
          <div class="bar-chart" aria-hidden="true">
            ${renderWeeklyCalorieBars(summary.days, today, maxCalories)}
          </div>
          <ul class="sr-only">
            ${summary.days.map(day => `<li>${escapeHTML(formatDateShort(day.date))}: ${day.status === 'missing' ? 'not logged' : `${day.incomplete?.includes('kcal') ? 'calories unknown' : `${day.calories} calories`}, ${day.incomplete?.includes('protein') ? 'protein unknown' : `${Math.round(day.protein)} grams protein`}${day.status === 'in-progress' ? ', day in progress' : ''}`}</li>`).join('')}
          </ul>
        </div>

        <div class="frequent-foods">
          <h3 class="section-subtitle">Most Logged This Week</h3>
          <div class="frequent-list">
            ${frequentFoods.map(item => `
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

  async function renderMonthView(sequence) {
    const today = todayStr();
    const goals = await getGoals();
    const monthData = [];

    for (let i = 29; i >= 0; i--) {
      const date = addCalendarDays(today, -i);
      const meals = await getByIndex('meals', 'date', date) || [];
      const totals = calculateDayTotalsSimple(meals);
      monthData.push({
        date,
        calories: totals.kcal,
        protein: totals.protein,
        incomplete: totals.incomplete,
        hasData: hasLoggedItems(meals),
      });
    }

    const summary = summarizeNutritionDays(monthData, today);

    const measurements = prepareWeightData(await getAll('measurements')).dailyEntries;
    const recentMeasurements = measurements.slice(-3);
    if (!isCurrentRender('month', sequence)) return;

    const contentDiv = container.querySelector('#insights-content');
    if (!contentDiv) return;
    contentDiv.innerHTML = `
      <div class="insights-section">
        <h2 class="section-title">Monthly Summary</h2>

        <div class="month-stats">
          <div class="month-stat">
            <div class="stat-icon">📊</div>
            <div class="stat-info">
              <span class="stat-label">Average Logged Day</span>
              <span class="stat-value">${formatAverage(summary.averageCalories, 'kcal', summary.averageCaloriesDays, summary.loggedDays.length)}</span>
            </div>
          </div>
          <div class="month-stat">
            <div class="stat-icon">P</div>
            <div class="stat-info">
              <span class="stat-label">Average Protein / Logged Day</span>
              <span class="stat-value">${formatAverage(summary.averageProtein, 'g', summary.averageProteinDays, summary.loggedDays.length)}</span>
            </div>
          </div>
          <div class="month-stat">
            <div class="stat-icon">✓</div>
            <div class="stat-info">
              <span class="stat-label">Past Days Logged</span>
              <span class="stat-value">${summary.loggedDays.length}</span>
            </div>
          </div>
        </div>
        ${renderAverageCompletenessNote(summary)}

        <div class="month-heatmap">
          <h3 class="chart-title">Logging Activity</h3>
          <div class="heatmap" role="list" aria-label="Nutrition logging activity for the last 30 days">
            ${summary.days.map(day => `
              <div
                class="heatmap-day ${day.status === 'logged' ? 'active' : day.status}"
                role="listitem"
                aria-label="${escapeHTML(formatDateShort(day.date))}: ${day.status === 'missing' ? 'not logged' : day.status}"
                title="${day.date}: ${day.status === 'missing' ? 'not logged' : day.status}"
              ></div>
            `).join('')}
          </div>
          <div class="chart-legend" aria-hidden="true"><span><i class="legend-logged"></i>Logged</span><span><i class="legend-in-progress"></i>In progress</span><span><i class="legend-missing"></i>Not logged</span></div>
          <p class="chart-note">Today is in progress and excluded from averages; past logged days may still be partial.</p>
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
                  <span class="measurement-weight">${m.weight.toFixed(1)} ${m.unit || 'kg'}</span>
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

  await render();
  return () => {
    disposed = true;
    contentSequence += 1;
  };
}

function hasEnabledGoal(target) {
  return Number.isFinite(Number(target)) && Number(target) > 0;
}

function formatStatGoal(target, unit, incomplete) {
  if (!hasEnabledGoal(target)) return incomplete ? 'known · no target' : 'no target';
  return `${incomplete ? 'known ' : ''}/${target}${unit}`;
}

function getDayLabel(dateStr) {
  const date = toLocalDate(dateStr);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
}

async function renderFoodBreakdown(meals) {
  const items = [];
  for (const meal of meals) {
    for (const item of (meal.items || [])) {
      const food = await getById('foods', item.foodId);
      const name = item.nameSnapshot || food?.name || item.foodId || 'Unknown';
      const kcal = item.nutrients?.kcal;
      items.push(`
        <div class="breakdown-item">
          <span>${escapeHTML(name)}</span>
          <span class="breakdown-kcal">${kcal != null && Number.isFinite(Number(kcal)) ? `${Math.round(Number(kcal))} kcal` : 'Calories unknown'}</span>
        </div>
      `);
    }
  }
  return items.join('');
}

function renderWeightTrendBars(measurements) {
  if (!measurements || measurements.length === 0) return '';
  const model = createWeightChartModel(measurements, { maxLabels: 4 });
  if (!model) return '';

  const accessibleSummary = model.entries
    .map(m => `${formatDateShort(m.date)}: ${m.weight.toFixed(1)} ${m.unit || ''}`)
    .join('; ');
  return `<div class="insights-weight-bars" role="img" aria-label="Weight trend. ${escapeHTML(accessibleSummary)}">
    <div class="insights-weight-bars-plot" aria-hidden="true">
      ${model.points.map(point => `<div class="insights-weight-bar-col" style="left:${point.x}%;width:${model.barWidthPercent}%;--weight-bar-height:${Math.max(point.height, 2)}%;">
        ${point.showValueLabel ? `<span class="insights-weight-bar-value">${point.entry.weight.toFixed(1)}</span>` : ''}
        <span class="insights-weight-bar"></span>
        ${point.showDateLabel ? `<span class="insights-weight-bar-date">${escapeHTML(formatDateShort(point.entry.date))}</span>` : ''}
      </div>`).join('')}
    </div>
  </div>`;
}

async function getMostFrequentFoods(today, days) {
  const foodCounts = {};

  for (let i = 0; i < days; i++) {
    const date = addCalendarDays(today, -i);
    const meals = await getByIndex('meals', 'date', date) || [];
    meals.forEach(meal => {
      (meal.items || []).forEach(item => {
        const foodId = item.foodId;
        foodCounts[foodId] = (foodCounts[foodId] || 0) + 1;
      });
    });
  }

  const counts = Object.entries(foodCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  return Promise.all(counts.map(async ([foodId, count]) => {
    const food = await getById('foods', foodId);
    return { name: food?.name || 'Unknown food', count };
  }));
}
