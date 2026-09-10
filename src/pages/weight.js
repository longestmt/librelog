import { getAll, getById, getSetting, put, softDelete } from '../data/db.js';
import { todayStr } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { createWeightChartModel, prepareWeightData } from '../engine/weight.js';
import { captureDataMutationGeneration } from '../data/operation-locks.js';
import { updateMeasurement } from '../data/measurement-commands.js';
import { captureLibreLogEntityContext } from '../sync/entity-context.js';

/**
 * Render the weight tracking page
 * @param {HTMLElement} container
 * @param {string} queryString
 */
export async function renderWeightPage(container, queryString) {
  let submitInProgress = false;

  async function render() {
    const mutationGeneration = captureDataMutationGeneration();
    const allEntries = await getAll('measurements');
    const preferredUnits = await getSetting('unit', 'metric');
    const weightData = prepareWeightData(allEntries);
    const sorted = weightData.entries;
    // One point per calendar day keeps repeated same-day readings from
    // overweighting averages and trends.
    const chartEntries = weightData.dailyEntries.slice(-30);
    const historySorted = [...sorted].reverse();

    // Stats
    const { current, starting } = weightData;
    const delta = weightData.delta;
    const avg = weightData.average;

    const chartModel = createWeightChartModel(chartEntries);
    const chartAccessibleSummary = chartEntries
      .map(entry => `${entry.date}: ${entry.weight.toFixed(1)} ${entry.unit}${entry.readingCount > 1 ? `, average of ${entry.readingCount} readings` : ''}`)
      .join('; ');

    const deltaSign = delta > 0 ? '+' : '';
    const deltaClass = delta > 0 ? 'weight-gain' : delta < 0 ? 'weight-loss' : '';

    container.innerHTML = `
      <div class="weight-page">

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
                <option value="kg" ${preferredUnits !== 'imperial' ? 'selected' : ''}>kg</option>
                <option value="lb" ${preferredUnits === 'imperial' ? 'selected' : ''}>lb</option>
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
          <h2 class="weight-section-title">Trend (Last ${chartEntries.length} logged days, ${weightData.displayUnit})</h2>
          <div class="weight-chart-container">
            <div class="weight-chart-y-axis">
              <span class="weight-chart-y-label">${chartModel.chartMax.toFixed(1)}</span>
              <span class="weight-chart-y-label">${((chartModel.chartMax + chartModel.chartMin) / 2).toFixed(1)}</span>
              <span class="weight-chart-y-label">${chartModel.chartMin.toFixed(1)}</span>
            </div>
            <div class="weight-chart" role="img" aria-label="Weight trend. ${escapeHTML(chartAccessibleSummary)}">
              <div class="weight-chart-plot">
                ${chartModel.trendLine ? `
                  <svg class="weight-trend-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                    <line
                      x1="${chartModel.trendLine.x1}"
                      y1="${chartModel.trendLine.y1}"
                      x2="${chartModel.trendLine.x2}"
                      y2="${chartModel.trendLine.y2}"
                    ></line>
                  </svg>
                ` : ''}
                <div class="weight-chart-bars">
                ${chartModel.points.map(point => {
                  const { entry, index: i } = point;
                  const isMin = i === chartModel.minIndex;
                  const isMax = i === chartModel.maxIndex;
                  const highlight = isMin ? 'weight-bar--min' : isMax ? 'weight-bar--max' : '';
                  const dateLabel = (entry.date || '').slice(5); // MM-DD
                  return `
                    <div class="weight-bar-col" style="left:${point.x}%;width:${chartModel.barWidthPercent}%;--weight-bar-height:${Math.max(point.height, 2)}%;" title="${escapeHTML(entry.date || '')}: ${entry.weight.toFixed(1)} ${escapeHTML(entry.unit)}${entry.readingCount > 1 ? `, average of ${entry.readingCount} readings` : ''}">
                      ${point.showValueLabel ? `<span class="weight-bar-value ${highlight}">${entry.weight.toFixed(1)}</span>` : ''}
                      <div class="weight-bar ${highlight}"></div>
                      ${point.showDateLabel ? `<span class="weight-bar-date">${escapeHTML(dateLabel)}</span>` : ''}
                    </div>
                  `;
                }).join('')}
                </div>
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
              <span class="weight-stat-value">${current ? `${current.weight.toFixed(1)} ${current.unit}` : '--'}</span>
            </div>
            <div class="weight-stat-card">
              <span class="weight-stat-label">Starting</span>
              <span class="weight-stat-value">${starting ? `${starting.weight.toFixed(1)} ${starting.unit}` : '--'}</span>
            </div>
            <div class="weight-stat-card">
              <span class="weight-stat-label">Change</span>
              <span class="weight-stat-value ${deltaClass}">${delta !== null ? `${deltaSign}${delta.toFixed(1)} ${weightData.displayUnit}` : '--'}</span>
            </div>
            <div class="weight-stat-card">
              <span class="weight-stat-label">Entries</span>
              <span class="weight-stat-value">${sorted.length}</span>
            </div>
            <div class="weight-stat-card">
              <span class="weight-stat-label">Average</span>
              <span class="weight-stat-value">${avg !== null ? `${avg.toFixed(1)} ${weightData.displayUnit}` : '--'}</span>
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
                <div class="weight-history-row" role="listitem" data-id="${escapeHTML(String(entry.id))}">
                  <div class="weight-history-info">
                    <span class="weight-history-date">${escapeHTML(entry.date || '')}</span>
                    <span class="weight-history-value">${entry.weight} ${escapeHTML(entry.unit || 'kg')}</span>
                    ${entry.bodyFat != null ? `<span class="weight-history-bf">${entry.bodyFat}% BF</span>` : ''}
                  </div>
                  <div>
                    <button class="btn btn-ghost btn-icon weight-edit-btn" data-id="${escapeHTML(String(entry.id))}" aria-label="Edit entry from ${escapeHTML(entry.date || '')}" tabindex="0">Edit</button>
                    <button class="btn btn-ghost btn-icon weight-delete-btn" data-id="${escapeHTML(String(entry.id))}" aria-label="Delete entry from ${escapeHTML(entry.date || '')}" tabindex="0">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1 2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
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
      if (submitInProgress) return;

      const date = document.getElementById('weight-date').value;
      const weight = parseFloat(document.getElementById('weight-value').value);
      const unit = document.getElementById('weight-unit').value;
      const bodyFatRaw = document.getElementById('weight-bodyfat').value;
      const bodyFat = bodyFatRaw !== '' ? parseFloat(bodyFatRaw) : null;

      if (!date || isNaN(weight) || weight <= 0) {
        showToast('Please enter a valid weight', 'error');
        return;
      }
      if (bodyFat !== null && (!Number.isFinite(bodyFat) || bodyFat < 0 || bodyFat > 100)) {
        showToast('Body fat must be between 0 and 100%', 'error');
        return;
      }

      submitInProgress = true;
      const submitButton = e.currentTarget.querySelector('[type="submit"]');
      submitButton.disabled = true;
      submitButton.textContent = 'Logging…';
      try {
        await put('measurements', {
          date,
          weight,
          unit,
          bodyFat,
        }, { mutationGeneration });

        showToast('Weight logged');
        await render();
      } catch (error) {
        console.error('Weight log failed:', error);
        showToast('Could not log weight', 'error');
      } finally {
        submitInProgress = false;
        if (submitButton.isConnected) {
          submitButton.disabled = false;
          submitButton.textContent = 'Log';
        }
      }
    });

    // Delete buttons
    document.querySelectorAll('.weight-edit-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const entryId = btn.dataset.id;
        // Read the causal context before re-reading the domain record. If a
        // remote write lands between the two reads, a later save may produce a
        // harmless extra conflict but can never claim to have observed values
        // that were not actually shown in this editor.
        const displayedContext = await captureLibreLogEntityContext('measurements', entryId);
        const entry = await getById('measurements', entryId);
        if (!entry) return;
        const content = document.createElement('div');
        content.className = 'modal-content';
        content.innerHTML = `
          <div class="modal-header"><h2>Edit Weight Entry</h2><button class="modal-close" id="edit-close" aria-label="Close">&#10005;</button></div>
          <label class="control-group"><span class="control-label">Date</span><input class="form-input" type="date" id="edit-weight-date" value="${escapeHTML(entry.date)}"></label>
          <label class="control-group"><span class="control-label">Weight</span><input class="form-input" type="number" min="0.1" step="0.1" id="edit-weight-value" value="${entry.weight}"></label>
          <label class="control-group"><span class="control-label">Unit</span><select class="form-input" id="edit-weight-unit"><option value="kg" ${entry.unit === 'kg' ? 'selected' : ''}>kg</option><option value="lb" ${entry.unit === 'lb' ? 'selected' : ''}>lb</option></select></label>
          <label class="control-group"><span class="control-label">Body Fat % (optional)</span><input class="form-input" type="number" min="0" max="100" step="0.1" id="edit-weight-bodyfat" value="${entry.bodyFat ?? ''}"></label>
          <div class="modal-actions"><button class="btn btn-secondary" id="edit-cancel">Cancel</button><button class="btn btn-primary" id="edit-save">Save</button></div>
        `;
        openModal(content);
        document.getElementById('edit-close')?.addEventListener('click', closeModal);
        document.getElementById('edit-cancel')?.addEventListener('click', closeModal);
        document.getElementById('edit-save')?.addEventListener('click', async () => {
          const weight = Number(document.getElementById('edit-weight-value').value);
          const date = document.getElementById('edit-weight-date').value;
          const bodyFatValue = document.getElementById('edit-weight-bodyfat').value;
          const bodyFat = bodyFatValue === '' ? null : Number(bodyFatValue);
          if (!date || !Number.isFinite(weight) || weight <= 0 || (bodyFat != null && (!Number.isFinite(bodyFat) || bodyFat < 0 || bodyFat > 100))) {
            showToast('Enter a valid measurement', 'error');
            return;
          }
          await updateMeasurement(entry.id, {
            date,
            weight,
            unit: document.getElementById('edit-weight-unit').value,
            bodyFat,
          }, {
            context: displayedContext,
            baseRecord: entry,
            mutationGeneration,
          });
          closeModal();
          showToast('Weight entry updated');
          render();
        });
      });
    });

    document.querySelectorAll('.weight-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const entryId = btn.dataset.id;
        const displayedContext = await captureLibreLogEntityContext('measurements', entryId);
        const entry = await getById('measurements', entryId);
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
          await softDelete('measurements', entryId, {
            context: displayedContext,
            mutationGeneration,
          });
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

  await render();
}
