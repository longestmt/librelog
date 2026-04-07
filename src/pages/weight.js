import { getAll, put, softDelete } from '../data/db.js';
import { todayStr } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';

/**
 * Render the weight tracking page
 * @param {HTMLElement} container
 * @param {string} queryString
 */
export function renderWeightPage(container, queryString) {
  async function render() {
    const allEntries = await getAll('measurements');
    // Sort by date ascending for chart/stats, then reverse for history
    const sorted = allEntries
      .filter(e => e.weight != null)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const chartEntries = sorted.slice(-30);
    const historySorted = [...sorted].reverse();

    // Stats
    const current = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    const starting = sorted.length > 0 ? sorted[0] : null;
    const delta = current && starting ? (current.weight - starting.weight).toFixed(1) : null;
    const avg = sorted.length > 0
      ? (sorted.reduce((sum, e) => sum + e.weight, 0) / sorted.length).toFixed(1)
      : null;

    // Chart calculations
    let minWeight = Infinity;
    let maxWeight = -Infinity;
    let minIdx = 0;
    let maxIdx = 0;
    chartEntries.forEach((e, i) => {
      if (e.weight < minWeight) { minWeight = e.weight; minIdx = i; }
      if (e.weight > maxWeight) { maxWeight = e.weight; maxIdx = i; }
    });

    const weightRange = maxWeight - minWeight || 1;
    const chartPadding = weightRange * 0.1;
    const chartMin = minWeight - chartPadding;
    const chartMax = maxWeight + chartPadding;
    const chartRange = chartMax - chartMin || 1;

    // Linear regression for trend line
    let trendStart = 0;
    let trendEnd = 0;
    if (chartEntries.length >= 2) {
      const n = chartEntries.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      chartEntries.forEach((e, i) => {
        sumX += i;
        sumY += e.weight;
        sumXY += i * e.weight;
        sumX2 += i * i;
      });
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;
      trendStart = ((intercept - chartMin) / chartRange) * 100;
      trendEnd = ((slope * (n - 1) + intercept - chartMin) / chartRange) * 100;
    }

    const deltaSign = delta > 0 ? '+' : '';
    const deltaClass = delta > 0 ? 'weight-gain' : delta < 0 ? 'weight-loss' : '';

    container.innerHTML = `
      <div class="weight-page" role="main" aria-label="Weight tracker">

        <!-- Header -->
        <div class="weight-header" role="banner">
          <h1 class="weight-title">Weight Tracker</h1>
          <button class="btn btn-primary" id="add-entry-btn" aria-label="Add weight entry" tabindex="0">Add Entry</button>
        </div>

        <!-- Quick-add form -->
        <form class="weight-quick-form" id="weight-quick-form" role="form" aria-label="Quick add weight entry">
          <div class="weight-form-row">
            <label class="weight-form-group">
              <span class="weight-form-label">Date</span>
              <input type="date" id="weight-date" class="weight-input" value="${todayStr()}" aria-label="Date" tabindex="0">
            </label>
            <label class="weight-form-group">
              <span class="weight-form-label">Weight</span>
              <input type="number" id="weight-value" class="weight-input" step="0.1" min="0" placeholder="0.0" required aria-label="Weight value" tabindex="0">
            </label>
            <label class="weight-form-group">
              <span class="weight-form-label">Unit</span>
              <select id="weight-unit" class="weight-input" aria-label="Weight unit" tabindex="0">
                <option value="kg">kg</option>
                <option value="lb">lb</option>
              </select>
            </label>
          </div>
          <div class="weight-form-row">
            <label class="weight-form-group weight-form-group--wide">
              <span class="weight-form-label">Body Fat % (optional)</span>
              <input type="number" id="weight-bodyfat" class="weight-input" step="0.1" min="0" max="100" placeholder="--" aria-label="Body fat percentage" tabindex="0">
            </label>
            <div class="weight-form-group weight-form-group--action">
              <button type="submit" class="btn btn-primary weight-log-btn" tabindex="0">Log</button>
            </div>
          </div>
        </form>

        <!-- Weight Trend Chart -->
        ${chartEntries.length > 0 ? `
        <section class="weight-chart-section" role="region" aria-label="Weight trend chart">
          <h2 class="weight-section-title">Trend (Last ${chartEntries.length} entries)</h2>
          <div class="weight-chart-container">
            <div class="weight-chart-y-axis">
              <span class="weight-chart-y-label">${maxWeight.toFixed(1)}</span>
              <span class="weight-chart-y-label">${((maxWeight + minWeight) / 2).toFixed(1)}</span>
              <span class="weight-chart-y-label">${minWeight.toFixed(1)}</span>
            </div>
            <div class="weight-chart" role="img" aria-label="Weight trend over last ${chartEntries.length} entries">
              <!-- Trend line -->
              ${chartEntries.length >= 2 ? `
              <div class="weight-trend-line" style="
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                top: 0;
                pointer-events: none;
                overflow: hidden;
              ">
                <div style="
                  position: absolute;
                  left: 0;
                  right: 0;
                  height: 2px;
                  background: var(--color-warning, #f59e0b);
                  opacity: 0.6;
                  bottom: ${trendStart}%;
                  transform-origin: left center;
                  transform: rotate(${-Math.atan2((trendEnd - trendStart), 100) * (180 / Math.PI)}deg);
                  width: ${Math.sqrt(10000 + (trendEnd - trendStart) * (trendEnd - trendStart))}%;
                "></div>
              </div>
              ` : ''}
              <!-- Bars -->
              <div class="weight-chart-bars">
                ${chartEntries.map((entry, i) => {
                  const heightPct = ((entry.weight - chartMin) / chartRange) * 100;
                  const isMin = i === minIdx;
                  const isMax = i === maxIdx;
                  const highlight = isMin ? 'weight-bar--min' : isMax ? 'weight-bar--max' : '';
                  const dateLabel = (entry.date || '').slice(5); // MM-DD
                  return `
                    <div class="weight-bar-col" title="${entry.date}: ${entry.weight} ${entry.unit || 'kg'}">
                      <span class="weight-bar-value ${highlight}">${entry.weight}</span>
                      <div class="weight-bar ${highlight}" style="height: ${Math.max(heightPct, 2)}%;" aria-label="${entry.date}: ${entry.weight} ${entry.unit || 'kg'}"></div>
                      <span class="weight-bar-date">${escapeHTML(dateLabel)}</span>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>
        </section>
        ` : ''}

        <!-- Stats Section -->
        <section class="weight-stats" role="region" aria-label="Weight statistics">
          <h2 class="weight-section-title">Statistics</h2>
          <div class="weight-stats-grid">
            <div class="weight-stat-card">
              <span class="weight-stat-label">Current</span>
              <span class="weight-stat-value">${current ? `${current.weight} ${current.unit || 'kg'}` : '--'}</span>
            </div>
            <div class="weight-stat-card">
              <span class="weight-stat-label">Starting</span>
              <span class="weight-stat-value">${starting ? `${starting.weight} ${starting.unit || 'kg'}` : '--'}</span>
            </div>
            <div class="weight-stat-card">
              <span class="weight-stat-label">Change</span>
              <span class="weight-stat-value ${deltaClass}">${delta !== null ? `${deltaSign}${delta}` : '--'}</span>
            </div>
            <div class="weight-stat-card">
              <span class="weight-stat-label">Entries</span>
              <span class="weight-stat-value">${sorted.length}</span>
            </div>
            <div class="weight-stat-card">
              <span class="weight-stat-label">Average</span>
              <span class="weight-stat-value">${avg !== null ? avg : '--'}</span>
            </div>
          </div>
        </section>

        <!-- CSV Export -->
        <section class="weight-export" role="region" aria-label="Export data">
          <button class="btn btn-ghost" id="export-csv-btn" aria-label="Export weight data as CSV" tabindex="0">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
        </section>

        <!-- History List -->
        <section class="weight-history" role="region" aria-label="Weight history">
          <h2 class="weight-section-title">History</h2>
          ${historySorted.length === 0 ? `
            <p class="weight-empty">No entries yet. Log your first weight above.</p>
          ` : `
            <div class="weight-history-list" role="list">
              ${historySorted.map(entry => `
                <div class="weight-history-row" role="listitem" data-id="${entry.id}">
                  <div class="weight-history-info">
                    <span class="weight-history-date">${escapeHTML(entry.date || '')}</span>
                    <span class="weight-history-value">${entry.weight} ${escapeHTML(entry.unit || 'kg')}</span>
                    ${entry.bodyFat != null ? `<span class="weight-history-bf">${entry.bodyFat}% BF</span>` : ''}
                  </div>
                  <button class="btn btn-ghost btn-icon weight-delete-btn" data-id="${entry.id}" aria-label="Delete entry from ${escapeHTML(entry.date || '')}" tabindex="0">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
              `).join('')}
            </div>
          `}
        </section>
      </div>
    `;

    // --- Event Listeners ---

    // Add Entry button scrolls to / focuses the quick-add form
    document.getElementById('add-entry-btn').addEventListener('click', () => {
      const weightInput = document.getElementById('weight-value');
      if (weightInput) {
        weightInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => weightInput.focus(), 300);
      }
    });

    // Quick-add form submit
    document.getElementById('weight-quick-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const date = document.getElementById('weight-date').value;
      const weight = parseFloat(document.getElementById('weight-value').value);
      const unit = document.getElementById('weight-unit').value;
      const bodyFatRaw = document.getElementById('weight-bodyfat').value;
      const bodyFat = bodyFatRaw !== '' ? parseFloat(bodyFatRaw) : null;

      if (!date || isNaN(weight) || weight <= 0) {
        showToast('Please enter a valid weight', 'error');
        return;
      }

      await put('measurements', {
        date,
        weight,
        unit,
        bodyFat,
      });

      showToast('Weight logged');
      render();
    });

    // Delete buttons
    document.querySelectorAll('.weight-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const entryId = btn.dataset.id;
        const entry = historySorted.find(e => e.id === entryId);
        if (!entry) return;

        const confirmContent = document.createElement('div');
        confirmContent.className = 'modal-content';
        confirmContent.innerHTML = `
          <div class="modal-header">
            <h2>Delete Entry</h2>
            <button class="modal-close" id="confirm-close" aria-label="Close">&#10005;</button>
          </div>
          <p style="margin: var(--sp-3) 0;">Delete weight entry from <strong>${escapeHTML(entry.date || '')}</strong> (${entry.weight} ${escapeHTML(entry.unit || 'kg')})?</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" id="confirm-cancel">Cancel</button>
            <button class="btn btn-delete" id="confirm-delete">Delete</button>
          </div>
        `;

        openModal(confirmContent);

        document.getElementById('confirm-close')?.addEventListener('click', closeModal);
        document.getElementById('confirm-cancel')?.addEventListener('click', closeModal);
        document.getElementById('confirm-delete')?.addEventListener('click', async () => {
          await softDelete('measurements', entryId);
          showToast('Entry deleted');
          closeModal();
          render();
        });
      });
    });

    // CSV Export
    document.getElementById('export-csv-btn')?.addEventListener('click', () => {
      if (sorted.length === 0) {
        showToast('No data to export', 'error');
        return;
      }

      const header = 'Date,Weight,Unit,BodyFat%';
      const rows = sorted.map(e => {
        const bf = e.bodyFat != null ? e.bodyFat : '';
        return `${e.date},${e.weight},${e.unit || 'kg'},${bf}`;
      });

      const csv = [header, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = `weight-export-${todayStr()}.csv`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      showToast('CSV exported');
    });
  }

  render();
}
