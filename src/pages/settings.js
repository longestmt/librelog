import { getSetting, setSetting, clearAllData } from '../data/db.js';
import { getGoals, setGoals } from '../engine/goal-tracking.js';
import { exportData, importData, importMyFitnessPalCSV } from '../data/io.js';
import {
  getWebDavConfig,
  setWebDavConfig,
  disconnectWebDav,
  pushToWebDav,
  pullFromWebDav,
} from '../data/webdav.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { escapeHTML } from '../utils/sanitize.js';
import { clearAutoBackups, stopAutoBackup } from '../data/auto-backup.js';
import {
  getCredential,
  hasCredential,
  removeCredential,
  setCredential,
} from '../data/credentials.js';

const APP_VERSION = '0.3.0';
const LICENSE = 'AGPL-3.0';

export function renderSettingsPage(container, queryString) {
  async function render() {
    const goals = await getGoals();
    const usdaApiKeyConfigured = await hasCredential('usdaApiKey');
    const aiProvider = await getSetting('ai_provider') || '';
    const aiApiKeyConfigured = await hasCredential('aiApiKey');
    const aiModel = await getSetting('ai_model') || '';
    const aiOllamaUrl = await getSetting('ai_ollama_url') || 'http://localhost:11434';
    const aiUsageLog = await getSetting('ai_usage_log') || [];
    const monthlyUsage = computeMonthlyUsage(aiUsageLog);
    let theme = await getSetting('theme') || 'compline';
    // Migrate old theme names
    const themeMap = { dark: 'compline', light: 'lauds', amoled: 'vigil' };
    if (themeMap[theme]) {
      theme = themeMap[theme];
      await setSetting('theme', theme);
    }
    const webdavConfig = await getWebDavConfig();
    const webdavConnected = Boolean(webdavConfig.url && webdavConfig.username && webdavConfig.password);
    const webdavUrl = webdavConfig.url || '';
    const webdavUsername = webdavConfig.username || '';

    container.innerHTML = `
      <div class="settings-page">
        <div class="settings-header">
          <h1>Settings</h1>
        </div>

        <div class="settings-container">
          <!-- Daily Goals Section -->
          <section class="settings-section">
            <h2 class="section-title">Daily Goals</h2>
            <div class="settings-group">
              <label class="setting-input">
                <span class="setting-label">Daily Calorie Target</span>
                <input type="number" id="goal-calories" min="500" step="50" value="${goals.calorieTarget}">
              </label>

              <label class="setting-input">
                <span class="setting-label">Protein Target (g)</span>
                <input type="number" id="goal-protein" min="0" step="5" value="${goals.proteinG}">
              </label>

              <label class="setting-input">
                <span class="setting-label">Carbs Target (g)</span>
                <input type="number" id="goal-carbs" min="0" step="10" value="${goals.carbG}">
              </label>

              <label class="setting-input">
                <span class="setting-label">Fat Target (g)</span>
                <input type="number" id="goal-fat" min="0" step="5" value="${goals.fatG}">
              </label>

              <label class="setting-input">
                <span class="setting-label">Fiber Target (g)</span>
                <input type="number" id="goal-fiber" min="0" step="5" value="${goals.fiberG || 30}">
              </label>

              <label class="setting-input">
                <span class="setting-label">Sodium Limit (mg)
                  <span class="setting-hint">Choose a personal limit appropriate for your needs</span>
                </span>
                <input type="number" id="goal-sodium" min="0" step="100" value="${goals.sodiumMg || 2300}">
              </label>

              <button class="btn btn-primary" id="save-goals-btn">Save Goals</button>
            </div>
          </section>

          <!-- Appearance Section -->
          <section class="settings-section">
            <h2 class="section-title">Appearance</h2>
            <div class="settings-group">
              <span class="setting-label">Theme</span>
              <div class="theme-chips">
                <button class="theme-chip ${theme === 'compline' ? 'active' : ''}" data-theme="compline">Compline</button>
                <button class="theme-chip ${theme === 'vigil' ? 'active' : ''}" data-theme="vigil">Vigil</button>
                <button class="theme-chip ${theme === 'lauds' ? 'active' : ''}" data-theme="lauds">Lauds</button>
              </div>
            </div>
          </section>

          <!-- AI / BYOK Section -->
          <section class="settings-section">
            <h2 class="section-title">AI Features (Optional)</h2>
            <p class="setting-hint" style="margin-bottom:var(--sp-3)">Bring your own API key for photo &amp; voice logging. Credentials are stored in this browser and excluded from exports; they are not encrypted by LibreLog.</p>
            <div class="settings-group">
              <label class="setting-input">
                <span class="setting-label">AI Provider</span>
                <select id="ai-provider" aria-label="AI provider">
                  <option value="" ${!aiProvider ? 'selected' : ''}>None (AI disabled)</option>
                  <option value="openai" ${aiProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
                  <option value="anthropic" ${aiProvider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                  <option value="ollama" ${aiProvider === 'ollama' ? 'selected' : ''}>Ollama (local)</option>
                </select>
              </label>

              <div id="ai-key-fields" style="${aiProvider === 'ollama' || !aiProvider ? 'display:none' : ''}">
                <label class="setting-input">
                  <span class="setting-label">API Key</span>
                  <input type="password" id="ai-api-key" placeholder="${aiApiKeyConfigured ? 'Key saved — enter a new value to replace it' : 'sk-... or sk-ant-...'}" value="" autocomplete="new-password">
                </label>
              </div>

              <div id="ai-ollama-fields" style="${aiProvider === 'ollama' ? '' : 'display:none'}">
                <label class="setting-input">
                  <span class="setting-label">Ollama URL</span>
                  <input type="url" id="ai-ollama-url" placeholder="http://localhost:11434" value="${escapeHTML(aiOllamaUrl)}">
                </label>
              </div>

              <label class="setting-input">
                <span class="setting-label">Model Override
                  <span class="setting-hint">Cloud providers have a default. For Ollama, enter an installed model name.</span>
                </span>
                <input type="text" id="ai-model" placeholder="Default" value="${escapeHTML(aiModel)}">
              </label>

              <button class="btn btn-primary btn-small" id="save-ai-btn">Save AI Settings</button>

              ${aiProvider ? `
                <div class="ai-cost-tracker">
                  <h3 class="setting-label" style="margin-top:var(--sp-3)">Usage This Month</h3>
                  <div class="ai-cost-stats">
                    <div class="ai-cost-stat">
                      <span class="ai-cost-label">Requests</span>
                      <span class="ai-cost-value">${monthlyUsage.count}</span>
                    </div>
                    <div class="ai-cost-stat">
                      <span class="ai-cost-label">Tokens</span>
                      <span class="ai-cost-value">${monthlyUsage.tokens.toLocaleString()}</span>
                    </div>
                    <div class="ai-cost-stat">
                      <span class="ai-cost-label">Rough Cost</span>
                      <span class="ai-cost-value">$${monthlyUsage.cost.toFixed(3)}</span>
                    </div>
                  </div>
                  <p class="setting-hint">Approximation only; verify billing with your provider.</p>
                </div>
              ` : ''}
            </div>
          </section>

          <!-- Integrations Section -->
          <section class="settings-section">
            <h2 class="section-title">Integrations</h2>
            <div class="settings-group">
              <label class="setting-input">
                <span class="setting-label">USDA FoodData Central API Key
                  <span class="setting-hint">Free key from fdc.nal.usda.gov — enables US food database</span>
                </span>
                <input type="password" id="usda-api-key" placeholder="${usdaApiKeyConfigured ? 'Key saved — enter a new value to replace it' : 'Your USDA API key (optional)'}" value="" autocomplete="new-password">
              </label>
              <button class="btn btn-primary btn-small" id="save-usda-key-btn">Save API Key</button>
              ${usdaApiKeyConfigured ? '<button class="btn btn-outline btn-small" id="remove-usda-key-btn">Remove API Key</button>' : ''}
            </div>
          </section>

          <!-- Data Section -->
          <section class="settings-section">
            <h2 class="section-title">Data Management</h2>
            <div class="settings-group">
              <button class="btn btn-outline" id="export-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export Data (JSON)
              </button>

              <button class="btn btn-outline" id="import-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Import Data
              </button>

              <button class="btn btn-outline" id="import-mfp-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Import from MyFitnessPal (CSV)
              </button>

              <button class="btn btn-outline btn-danger" id="clear-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                Clear All Data
              </button>
            </div>
          </section>

          <!-- WebDAV Backup Section -->
          <section class="settings-section">
            <h2 class="section-title">WebDAV Backup</h2>
            <div class="settings-group">
              <div id="webdav-status" class="webdav-status">
                <span class="status-label">Connection Status:</span>
                <span class="status-badge ${webdavConnected ? 'connected' : 'disconnected'}">
                  ${webdavConnected ? 'Connected' : 'Not Connected'}
                </span>
              </div>

              ${webdavConnected ? `
                <div class="webdav-actions">
                  <button class="btn btn-small" id="webdav-push">Create Backup</button>
                  <button class="btn btn-small" id="webdav-pull">Restore Backup</button>
                  <button class="btn btn-small btn-outline" id="webdav-disconnect">Disconnect</button>
                </div>
              ` : `
                <label class="setting-input">
                  <span class="setting-label">WebDAV Server URL</span>
                  <input type="url" id="webdav-url" placeholder="https://example.com/remote.php/webdav/" value="${escapeHTML(webdavUrl)}">
                </label>

                <label class="setting-input">
                  <span class="setting-label">Username</span>
                  <input type="text" id="webdav-username" placeholder="username" value="${escapeHTML(webdavUsername)}">
                </label>

                <label class="setting-input">
                  <span class="setting-label">Password</span>
                  <input type="password" id="webdav-password" placeholder="password" value="">
                </label>

                <button class="btn btn-primary" id="webdav-test">Connect</button>
              `}
            </div>
          </section>

          <!-- About Section -->
          <section class="settings-section">
            <h2 class="section-title">About</h2>
            <div class="about-content">
              <div class="about-item">
                <span class="about-label">LibreLog</span>
                <span class="about-value">v${APP_VERSION}</span>
              </div>
              <div class="about-item">
                <span class="about-label">License</span>
                <span class="about-value">${LICENSE}</span>
              </div>
              <div class="about-item">
                <span class="about-label">Part of the Libre Suite</span>
                <span class="about-value">Free &amp; Open Source</span>
              </div>
              <div class="about-links">
                <a href="https://github.com/libresuite/librelog" target="_blank" rel="noopener noreferrer" class="about-link">
                  Source Code
                </a>
                <a href="https://openfoodfacts.org/" target="_blank" rel="noopener noreferrer" class="about-link">
                  Open Food Facts
                </a>
              </div>
              <div class="about-attribution">
                <p>Compline &amp; Lauds themes by <a href="https://joshuablais.com" target="_blank" rel="noopener noreferrer">Joshua Blais</a></p>
                <p>Built with care for your health and your privacy.</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;

    // Event listeners
    document.getElementById('save-goals-btn')?.addEventListener('click', saveGoals);

    document.querySelectorAll('.theme-chip').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const theme = e.currentTarget.dataset.theme;
        applyTheme(theme);
        await setSetting('theme', theme);
        const themeNames = { compline: 'Compline', vigil: 'Vigil', lauds: 'Lauds' };
        showToast(`Theme changed to ${themeNames[theme] || theme}`);
        render();
      });
    });

    // AI provider toggle visibility
    document.getElementById('ai-provider')?.addEventListener('change', (e) => {
      const provider = e.target.value;
      const keyFields = document.getElementById('ai-key-fields');
      const ollamaFields = document.getElementById('ai-ollama-fields');
      if (keyFields) keyFields.style.display = (provider && provider !== 'ollama') ? '' : 'none';
      if (ollamaFields) ollamaFields.style.display = provider === 'ollama' ? '' : 'none';
    });

    document.getElementById('save-ai-btn')?.addEventListener('click', async () => {
      const provider = document.getElementById('ai-provider').value;
      const apiKey = document.getElementById('ai-api-key')?.value.trim() || '';
      const existingApiKey = await getCredential('aiApiKey') || '';
      const model = document.getElementById('ai-model')?.value.trim() || '';
      const ollamaUrl = document.getElementById('ai-ollama-url')?.value.trim() || 'http://localhost:11434';

      if (provider && provider !== 'ollama' && !apiKey && !existingApiKey) {
        showToast('Please enter an API key for ' + provider);
        return;
      }
      if (provider === 'ollama' && !model) {
        showToast('Enter the name of an installed Ollama model');
        return;
      }

      await setSetting('ai_provider', provider);
      if (!provider) await removeCredential('aiApiKey');
      else if (apiKey) await setCredential('aiApiKey', apiKey);
      await setSetting('ai_model', model);
      await setSetting('ai_ollama_url', ollamaUrl);
      showToast(provider ? `AI configured with ${provider}` : 'AI features disabled');
      render();
    });

    document.getElementById('save-usda-key-btn')?.addEventListener('click', async () => {
      const key = document.getElementById('usda-api-key').value.trim();
      if (!key) {
        showToast(usdaApiKeyConfigured ? 'Enter a new key, or use Remove API Key' : 'Enter an API key');
        return;
      }
      await setCredential('usdaApiKey', key);
      showToast('USDA API key saved');
      render();
    });
    document.getElementById('remove-usda-key-btn')?.addEventListener('click', async () => {
      await removeCredential('usdaApiKey');
      showToast('USDA API key removed');
      render();
    });

    document.getElementById('export-btn')?.addEventListener('click', handleExport);
    document.getElementById('import-btn')?.addEventListener('click', handleImport);
    document.getElementById('import-mfp-btn')?.addEventListener('click', handleMFPImport);
    document.getElementById('clear-btn')?.addEventListener('click', handleClear);

    document.getElementById('webdav-test')?.addEventListener('click', handleWebDAVTest);
    document.getElementById('webdav-push')?.addEventListener('click', handleWebDAVPush);
    document.getElementById('webdav-pull')?.addEventListener('click', handleWebDAVPull);
    document.getElementById('webdav-disconnect')?.addEventListener('click', handleWebDAVDisconnect);
  }

  async function saveGoals() {
    const calorieTarget = Number(document.getElementById('goal-calories').value);
    const proteinG = Number(document.getElementById('goal-protein').value);
    const carbG = Number(document.getElementById('goal-carbs').value);
    const fatG = Number(document.getElementById('goal-fat').value);
    const fiberG = Number(document.getElementById('goal-fiber').value);
    const sodiumMg = Number(document.getElementById('goal-sodium').value);

    await setGoals({ calorieTarget, proteinG, carbG, fatG, fiberG, sodiumMg });
    showToast('Goals saved');
  }

  function applyTheme(theme) {
    if (theme === 'compline') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  async function handleExport() {
    try {
      await exportData();
      showToast('Data exported');
    } catch (err) {
      console.error('Export failed:', err);
      showToast('Export failed. Please try again.');
    }
  }

  function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        await importData(file);
        showToast('Data imported successfully');
        render();
      } catch (err) {
        console.error('Import failed:', err);
        showToast(`Import failed: ${err.message || 'check the file format'}`);
      }
    });
    input.click();
  }

  function handleClear() {
    const modal = document.createElement('div');
    modal.className = 'modal-content confirm-modal';
    modal.innerHTML = `
      <div class="modal-header">
        <h2>Clear All Data?</h2>
      </div>
      <p class="confirm-message">This will permanently delete all your foods, meals, and settings. This action cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-danger" id="confirm-btn">Delete Everything</button>
      </div>
    `;

    openModal(modal);

    document.getElementById('cancel-btn').addEventListener('click', closeModal);
    document.getElementById('confirm-btn').addEventListener('click', async () => {
      try {
        stopAutoBackup();
        await clearAutoBackups();
        await clearAllData();
        closeModal();
        showToast('All data cleared');
        setTimeout(() => {
          window.location.reload();
        }, 500);
      } catch (err) {
        console.error('Clear failed:', err);
        showToast('Failed to clear data');
      }
    });
  }

  function handleMFPImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        showToast('Importing MyFitnessPal data...');
        const result = await importMyFitnessPalCSV(file);
        showToast(`Imported ${result.imported} meals (${result.skipped} skipped)`);
        render();
      } catch (err) {
        console.error('MFP import failed:', err);
        showToast('Import failed: ' + err.message);
      }
    });
    input.click();
  }

  async function handleWebDAVTest() {
    const url = document.getElementById('webdav-url').value.trim();
    const username = document.getElementById('webdav-username').value.trim();
    const password = document.getElementById('webdav-password').value;

    if (!url || !username || !password) {
      showToast('Please fill in all WebDAV fields');
      return;
    }

    const btn = document.getElementById('webdav-test');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Testing...';

    try {
      await setWebDavConfig(url, username, password);
      showToast('Connection successful');
      render();
    } catch (err) {
      console.error('WebDAV test failed:', err);
      showToast('Connection error. Check your credentials and URL.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Connect';
    }
  }

  async function handleWebDAVPush() {
    const btn = document.getElementById('webdav-push');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Pushing...';

    try {
      await pushToWebDav();
      showToast('WebDAV backup created');
    } catch (err) {
      console.error('Push failed:', err);
      showToast('Failed to push data');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Create Backup';
    }
  }

  function handleWebDAVPull() {
    const modal = document.createElement('div');
    modal.className = 'modal-content confirm-modal';
    modal.innerHTML = `
      <div class="modal-header"><h2>Restore WebDAV Backup?</h2></div>
      <p class="confirm-message">This replaces local meals, foods, recipes, measurements, and non-secret settings with the server backup. Local credentials are preserved.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-danger" id="confirm-btn">Restore Backup</button>
      </div>
    `;
    openModal(modal);
    document.getElementById('cancel-btn').addEventListener('click', closeModal);
    document.getElementById('confirm-btn').addEventListener('click', async (event) => {
      await performWebDAVPull(event.currentTarget);
    });
  }

  async function performWebDAVPull(btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Restoring...';

    try {
      await pullFromWebDav();
      closeModal();
      showToast('WebDAV backup restored');
      render();
    } catch (err) {
      console.error('Pull failed:', err);
      showToast(`Restore failed: ${err.message || 'check the connection'}`);
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = 'Restore Backup';
      }
    }
  }

  async function handleWebDAVDisconnect() {
    await disconnectWebDav();
    showToast('WebDAV disconnected');
    render();
  }

  render();
}

function computeMonthlyUsage(log) {
  if (!Array.isArray(log) || log.length === 0) return { count: 0, tokens: 0, cost: 0 };
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thisMonth = log.filter(e => e.date >= monthStart);
  return {
    count: thisMonth.length,
    tokens: thisMonth.reduce((s, e) => s + (e.tokens || 0), 0),
    cost: thisMonth.reduce((s, e) => s + (e.cost || 0), 0),
  };
}
