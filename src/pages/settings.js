import {
  getMigrationBackupData,
  getMigrationBackups,
  getSetting,
  importAllData,
  setSetting,
} from '../data/db.js';
import { getGoals, setGoals } from '../engine/goal-tracking.js';
import {
  exportData,
  exportEncryptedData,
  importMyFitnessPalCSV,
  prepareImportData,
  summarizeImportData,
} from '../data/io.js';
import {
  activateStoredWebDavConfig,
  getWebDavConfig,
  setWebDavConfig,
  disconnectWebDav,
  pushToWebDav,
  pullFromWebDav,
} from '../data/webdav.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { escapeHTML } from '../utils/sanitize.js';
import { initAutoBackup, replaceAllDataWithSafetyBackup } from '../data/auto-backup.js';
import { normalizeOllamaUrl } from '../integrations/ollama.js';
import { saveAISettingsSafely } from '../integrations/ai-settings.js';
import { captureDataMutationGeneration } from '../data/operation-locks.js';
import {
  enableCredentialEncryption,
  hasStoredCredential,
  isCredentialEncryptionEnabled,
  isCredentialStoreUnlocked,
  lockCredentialStore,
  removeUsdaApiKey,
  saveUsdaApiKey,
  unlockCredentialStore,
} from '../data/credentials.js';
import {
  clearThisDeviceAndDisconnect,
  createLibreSyncVault,
  deleteLibreLogDataEverywhere,
  deleteLibreSyncVault,
  disconnectLibreSync,
  getLibreSyncClient,
  getLibreSyncPreferences,
  joinLibreSyncVault,
  setLibreSyncPreferences,
  syncLibreLogNow,
} from '../sync/service.js';
import { captureLibreLogEntityContext } from '../sync/entity-context.js';

const APP_VERSION = '0.4.2';
const LICENSE = 'AGPL-3.0';

export async function renderSettingsPage(container, queryString) {
  let unsubscribeSyncStatus = null;

  async function render() {
    const mutationGeneration = captureDataMutationGeneration();
    const [displayedGoalsContext, initialThemeContext, displayedUnitContext] = await Promise.all([
      captureLibreLogEntityContext('settings', 'nutritionGoals'),
      captureLibreLogEntityContext('settings', 'theme'),
      captureLibreLogEntityContext('settings', 'unit'),
    ]);
    const goals = await getGoals();
    const credentialEncryptionEnabled = await isCredentialEncryptionEnabled();
    const credentialStoreUnlocked = await isCredentialStoreUnlocked();
    const usdaApiKeyConfigured = await hasStoredCredential('usdaApiKey');
    const aiProvider = await getSetting('ai_provider') || '';
    const aiApiKeyConfigured = await hasStoredCredential('aiApiKey');
    const storedAiApiKeyProvider = await getSetting('ai_api_key_provider', null);
    const aiApiKeyProvider = storedAiApiKeyProvider;
    const aiApiKeyUsable = aiApiKeyConfigured && aiApiKeyProvider === aiProvider;
    const aiModel = await getSetting('ai_model') || '';
    const aiOllamaUrl = await getSetting('ai_ollama_url') || 'http://localhost:11434';
    const aiPrivacyConsent = aiProvider
      ? await getSetting(`privacyConsent_ai_${aiProvider}`, false)
      : false;
    const usdaPrivacyConsent = await getSetting('privacyConsent_usda', false);
    const webdavPrivacyConsent = await getSetting('privacyConsent_webdav', false);
    const aiUsageLog = await getSetting('ai_usage_log') || [];
    const monthlyUsage = computeMonthlyUsage(aiUsageLog);
    let displayedThemeContext = initialThemeContext;
    let theme = await getSetting('theme') || 'compline';
    const unit = await getSetting('unit') || 'metric';
    // Migrate old theme names
    const themeMap = { dark: 'compline', light: 'lauds', amoled: 'vigil' };
    if (themeMap[theme]) {
      theme = themeMap[theme];
      await setSetting('theme', theme, {
        context: displayedThemeContext,
        mutationGeneration,
      });
      // Keep the context and value used by the rendered controls from the same
      // materialized version after the migration write.
      displayedThemeContext = await captureLibreLogEntityContext('settings', 'theme');
      theme = await getSetting('theme') || theme;
    }
    const webdavConfig = await getWebDavConfig();
    const webdavPasswordConfigured = await hasStoredCredential('webdavPassword');
    const webdavConfigured = Boolean(webdavConfig.url && webdavConfig.username && webdavPasswordConfigured);
    const webdavConnected = webdavConfigured
      && webdavConfig.active === true
      && webdavPrivacyConsent;
    const webdavUrl = webdavConfig.url || '';
    const webdavUsername = webdavConfig.username || '';
    const migrationBackups = getMigrationBackups();
    const lastPortableBackupTime = await getSetting('lastPortableBackupTime', null);
    const portableBackupDue = !lastPortableBackupTime
      || Date.now() - Number(lastPortableBackupTime) > 30 * 24 * 60 * 60 * 1000;
    const syncClient = await getLibreSyncClient();
    const [syncPreferences, syncStatus] = await Promise.all([
      getLibreSyncPreferences(),
      syncClient.getStatus(),
    ]);
    const syncServerUrl = syncStatus.serverUrl || syncPreferences.serverUrl;

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
                <input type="number" id="goal-fiber" min="0" step="5" value="${goals.fiberG ?? 30}">
              </label>

              <label class="setting-input">
                <span class="setting-label">Sodium Limit (mg)
                  <span class="setting-hint">Choose a personal limit appropriate for your needs</span>
                </span>
                <input type="number" id="goal-sodium" min="0" step="100" value="${goals.sodiumMg ?? 2300}">
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
              <label class="setting-input">
                <span class="setting-label">Default Units</span>
                <select id="default-unit" aria-label="Default measurement units">
                  <option value="metric" ${unit === 'metric' ? 'selected' : ''}>Metric</option>
                  <option value="imperial" ${unit === 'imperial' ? 'selected' : ''}>Imperial</option>
                </select>
              </label>
            </div>
          </section>

          <section class="settings-section" aria-labelledby="libresync-heading">
            <h2 class="section-title" id="libresync-heading">LibreSync</h2>
            <div class="settings-group">
              <p class="setting-hint">End-to-end encrypted synchronization for LibreLog. The relay stores encrypted operations, while vault keys and device credentials stay in this browser profile.</p>
              <label class="setting-input">
                <span class="setting-label">Remote Data Consent
                  <span class="setting-hint">When connected, LibreLog sends encrypted foods, meals, recipes, measurements, notes, templates, goals, theme, and units to the server you choose. Backups remain a separate feature.</span>
                </span>
                <span><input type="checkbox" id="libresync-consent" ${syncPreferences.consent ? 'checked' : ''} ${syncStatus.connected ? 'disabled' : ''}> I consent to this encrypted remote data transfer.</span>
              </label>
              <label class="setting-input">
                <span class="setting-label">Server URL
                  <span class="setting-hint">Use HTTPS in production. Plain HTTP is accepted only for localhost development.</span>
                </span>
                <input type="url" id="libresync-server-url" placeholder="https://sync.example.com" value="${escapeHTML(syncServerUrl)}" ${syncStatus.connected ? 'disabled' : ''}>
              </label>
              <label class="setting-input">
                <span class="setting-label">Device Label</span>
                <input type="text" id="libresync-device-label" maxlength="100" value="${escapeHTML(syncStatus.connected ? syncStatus.deviceLabel : syncPreferences.deviceLabel)}" ${syncStatus.connected ? 'disabled' : ''}>
              </label>

              <div class="webdav-status" aria-live="polite">
                <span class="status-label">Status:</span>
                <span id="libresync-status" class="status-badge ${syncStatus.connected ? 'connected' : 'disconnected'}">${escapeHTML(syncStatus.connected ? syncStateLabel(syncStatus.automaticSync) : 'Not connected')}</span>
              </div>
              <div class="ai-cost-stats" aria-label="LibreSync counts">
                <div class="ai-cost-stat"><span class="sync-count-label">Pending</span><span class="ai-cost-value" id="libresync-pending">${syncStatus.pendingCount}</span></div>
                <div class="ai-cost-stat"><span class="sync-count-label">Needs Update</span><span class="ai-cost-value" id="libresync-quarantined">${syncStatus.quarantinedCount}</span></div>
                <div class="ai-cost-stat"><span class="sync-count-label">Conflicts</span><span class="ai-cost-value" id="libresync-conflicts">${syncStatus.conflictCount}</span></div>
              </div>
              <p class="setting-hint" id="libresync-last-sync">Last successful sync: ${escapeHTML(formatSyncDate(syncStatus.lastSuccessfulSync))}</p>
              ${syncStatus.lastError ? `<p class="setting-hint" id="libresync-last-error">Last attempt: ${escapeHTML(syncStatus.lastError)}</p>` : '<p class="setting-hint" id="libresync-last-error"></p>'}

              ${syncStatus.connected ? `
                <div class="webdav-actions">
                  <button class="btn btn-primary btn-small" id="libresync-sync-now">Sync Now</button>
                  <button class="btn btn-outline btn-small" id="libresync-pair">Pair Another Device</button>
                  <button class="btn btn-outline btn-small" id="libresync-devices">Manage Devices</button>
                  <button class="btn btn-outline btn-small" id="libresync-review-conflicts">Review Conflicts (${syncStatus.conflictCount})</button>
                </div>
                <p class="setting-hint">Offline changes remain available and sync when this app is open again. Closed-app background sync is not promised. Revoking a device blocks future relay access but cannot erase data or a vault key it already downloaded.</p>
                <div class="webdav-actions">
                  <button class="btn btn-outline btn-small" id="libresync-disconnect">Disconnect and Keep Local Data</button>
                  <button class="btn btn-outline btn-danger btn-small" id="libresync-delete-everywhere">Delete Synced App Data Everywhere</button>
                  <button class="btn btn-outline btn-danger btn-small" id="libresync-delete-vault">Permanently Delete Remote Vault</button>
                </div>
              ` : `
                <button class="btn btn-outline btn-small" id="libresync-save-preferences">Save Sync Settings</button>
                <div class="webdav-actions">
                  <button class="btn btn-primary btn-small" id="libresync-create-vault">Create New Vault</button>
                </div>
                <label class="setting-input">
                  <span class="setting-label">Pairing URI or JSON
                    <span class="setting-hint">Paste the single-use payload from an authorized LibreLog device. If this device has existing data, LibreLog asks you to save a portable JSON backup. Browsers without direct file saving download it, then ask you to select that file once to verify it.</span>
                  </span>
                  <textarea id="libresync-pairing-payload" rows="5" autocomplete="off" spellcheck="false"></textarea>
                </label>
                <button class="btn btn-outline btn-small" id="libresync-join-vault">Join Existing Vault</button>
                <p class="setting-hint">There is no recovery phrase in this version. An authorized connected device is required to pair a new one.</p>
              `}
              <p class="setting-hint">Browser-local key storage is protected only by this browser profile and app origin. End-to-end encryption does not protect a compromised device, browser profile, app, or authorized malicious replica.</p>
            </div>
          </section>

          <!-- AI / BYOK Section -->
          <section class="settings-section">
            <h2 class="section-title">Credential Protection (Optional)</h2>
            <div class="settings-group">
              <p class="setting-hint">${credentialEncryptionEnabled
                ? (credentialStoreUnlocked
                  ? 'Credentials are encrypted at rest and unlocked in memory for this app session.'
                  : 'Credentials are encrypted and locked. Unlock them before you use a remote integration.')
                : 'Credentials are stored as plaintext in this browser profile. You can encrypt them with a passphrase.'}</p>
              ${credentialEncryptionEnabled
                ? (credentialStoreUnlocked
                  ? '<button class="btn btn-outline btn-small" id="lock-credentials-btn">Lock Credentials</button>'
                  : '<button class="btn btn-primary btn-small" id="unlock-credentials-btn">Unlock Credentials</button>')
                : '<button class="btn btn-primary btn-small" id="protect-credentials-btn">Encrypt Stored Credentials</button>'}
              <p class="setting-hint">LibreLog does not store or recover this passphrase. A page that runs on this origin can read credentials while the store is unlocked.</p>
            </div>
          </section>

          <section class="settings-section">
            <h2 class="section-title">AI Features (Optional)</h2>
            <p class="setting-hint" style="margin-bottom:var(--sp-3)">Bring your own API key for photo &amp; voice logging. Credentials are excluded from exports. ${credentialEncryptionEnabled ? 'Credential protection encrypts them while the store is locked.' : 'They are not encrypted in this browser profile.'}</p>
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
                  <input type="password" id="ai-api-key" placeholder="${aiApiKeyUsable ? 'Key saved — enter a new value to replace it' : 'Enter a key for this provider'}" value="" autocomplete="new-password">
                </label>
              </div>

              <div id="ai-ollama-fields" style="${aiProvider === 'ollama' ? '' : 'display:none'}">
                <label class="setting-input">
                  <span class="setting-label">Ollama URL
                    <span class="setting-hint">For privacy, LibreLog only connects to Ollama on this device (localhost, 127.0.0.1, or [::1]).</span>
                  </span>
                  <input type="url" id="ai-ollama-url" placeholder="http://localhost:11434" value="${escapeHTML(aiOllamaUrl)}">
                </label>
              </div>

              <label class="setting-input">
                <span class="setting-label">Model Override
                  <span class="setting-hint">Cloud providers have a default. For Ollama, enter an installed model name.</span>
                </span>
                <input type="text" id="ai-model" placeholder="Default" value="${escapeHTML(aiModel)}">
              </label>

              <label class="setting-input" id="ai-privacy-row" style="${aiProvider && aiProvider !== 'ollama' ? '' : 'display:none'}">
                <span class="setting-label">Remote AI Data
                  <span class="setting-hint">The selected cloud provider receives the descriptions, images, or audio that you submit. The provider applies its own privacy terms. LibreLog does not send your diary history.</span>
                </span>
                <span><input type="checkbox" id="ai-privacy-consent" ${aiPrivacyConsent ? 'checked' : ''}> I understand this remote data use.</span>
              </label>

              <button class="btn btn-primary btn-small" id="save-ai-btn" ${credentialEncryptionEnabled && !credentialStoreUnlocked ? 'disabled' : ''}>Save AI Settings</button>

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
              <label class="setting-input">
                <span class="setting-label">USDA Data Use
                  <span class="setting-hint">USDA FoodData Central receives food search terms and food identifiers. LibreLog does not send your diary history.</span>
                </span>
                <span><input type="checkbox" id="usda-privacy-consent" ${usdaPrivacyConsent ? 'checked' : ''}> I understand this remote data use.</span>
              </label>
              <button class="btn btn-primary btn-small" id="save-usda-key-btn" ${credentialEncryptionEnabled && !credentialStoreUnlocked ? 'disabled' : ''}>Save API Key</button>
              ${usdaApiKeyConfigured ? '<button class="btn btn-outline btn-small" id="remove-usda-key-btn">Remove API Key</button>' : ''}
            </div>
          </section>

          <!-- Data Section -->
          <section class="settings-section">
            <h2 class="section-title">Data Management</h2>
            <div class="settings-group">
              ${portableBackupDue ? `
                <p class="setting-hint">Make a portable backup. Browser automatic backups stay in this browser profile and do not protect against device or profile loss.</p>
              ` : ''}
              <button class="btn btn-outline" id="export-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export Data (JSON)
              </button>

              <button class="btn btn-outline" id="export-encrypted-btn">
                Export Encrypted Data
              </button>

              <button class="btn btn-outline" id="import-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Import Data
              </button>

              <button class="btn btn-outline" id="import-mfp-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Import from MyFitnessPal (CSV)
              </button>

              ${migrationBackups.length ? `
                <div class="setting-input">
                  <span class="setting-label">Migration Checkpoint
                    <span class="setting-hint">LibreLog made this local checkpoint before it changed the database. Credentials are not in the checkpoint.</span>
                  </span>
                  <select id="migration-backup" aria-label="Migration checkpoint">
                    ${migrationBackups.map(backup => `
                      <option value="${escapeHTML(backup.timestamp)}">
                        ${escapeHTML(formatCheckpointDate(backup.timestamp))} — schema ${backup.fromVersion} to ${backup.toVersion}
                      </option>
                    `).join('')}
                  </select>
                  <button class="btn btn-outline btn-small" id="restore-migration-btn">Restore Checkpoint</button>
                </div>
              ` : ''}

              <button class="btn btn-outline btn-danger" id="clear-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                Clear This Device and Disconnect
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
                  ${webdavConfigured && !webdavConnected
                    ? 'Review Required'
                    : webdavConnected
                    ? (credentialEncryptionEnabled && !credentialStoreUnlocked ? 'Locked' : 'Connected')
                    : 'Not Connected'}
                </span>
              </div>

              ${webdavConfigured ? `
                ${!webdavConnected ? `
                  <label class="setting-input">
                    <span class="setting-label">WebDAV Data Use
                      <span class="setting-hint">A backup sends meal, food, recipe, measurement, and non-secret setting data to this server. LibreLog will securely recheck this saved connection before enabling it.</span>
                    </span>
                    <span><input type="checkbox" id="webdav-existing-privacy-consent"> I understand this remote data use.</span>
                  </label>
                  <div class="webdav-actions">
                    <button class="btn btn-primary btn-small" id="webdav-enable">Enable WebDAV Backup</button>
                    <button class="btn btn-small btn-outline" id="webdav-disconnect">Disconnect</button>
                  </div>
                ` : credentialEncryptionEnabled && !credentialStoreUnlocked
                  ? '<p class="setting-hint">Unlock credentials to use or disconnect WebDAV.</p>'
                  : `<div class="webdav-actions">
                      <button class="btn btn-small" id="webdav-push">Create Backup</button>
                      <button class="btn btn-small" id="webdav-push-encrypted">Create Encrypted Backup</button>
                      <button class="btn btn-small" id="webdav-pull">Restore Backup</button>
                      <button class="btn btn-small" id="webdav-pull-encrypted">Restore Encrypted Backup</button>
                      <button class="btn btn-small btn-outline" id="webdav-disconnect">Disconnect</button>
                    </div>`}
                ${webdavPrivacyConsent ? '<p class="setting-hint">Encrypted backups use a passphrase for one operation. LibreLog does not store the passphrase and cannot recover it.</p>' : ''}
              ` : `
                <label class="setting-input">
                  <span class="setting-label">WebDAV Server URL</span>
                  <input type="url" id="webdav-url" placeholder="https://example.com/remote.php/webdav/" value="${escapeHTML(webdavUrl)}" autocomplete="url" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="url">
                </label>

                <label class="setting-input">
                  <span class="setting-label">Username
                    <span class="setting-hint">Usernames are case-sensitive.</span>
                  </span>
                  <input type="text" id="webdav-username" placeholder="username" value="${escapeHTML(webdavUsername)}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false">
                </label>

                <label class="setting-input">
                  <span class="setting-label">Password / app password</span>
                  <input type="password" id="webdav-password" placeholder="password" value="" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false">
                </label>

                <label class="setting-input">
                  <span class="setting-label">WebDAV Data Use
                    <span class="setting-hint">A backup sends meal, food, recipe, measurement, and non-secret setting data to this server. HTTPS is required except for localhost. Use encrypted backup for data protection on the server.</span>
                  </span>
                  <span><input type="checkbox" id="webdav-privacy-consent" ${webdavPrivacyConsent ? 'checked' : ''}> I understand this remote data use.</span>
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
                <a href="https://github.com/longestmt/librelog" target="_blank" rel="noopener noreferrer" class="about-link">
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
    document.getElementById('save-goals-btn')?.addEventListener('click', () => saveGoals({
      context: displayedGoalsContext,
      mutationGeneration,
    }));
    document.getElementById('protect-credentials-btn')?.addEventListener('click', handleProtectCredentials);
    document.getElementById('unlock-credentials-btn')?.addEventListener('click', handleUnlockCredentials);
    document.getElementById('lock-credentials-btn')?.addEventListener('click', () => {
      lockCredentialStore();
      showToast('Credentials locked');
      render();
    });

    document.querySelectorAll('.theme-chip').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const theme = e.currentTarget.dataset.theme;
        applyTheme(theme);
        await setSetting('theme', theme, {
          context: displayedThemeContext,
          mutationGeneration,
        });
        const themeNames = { compline: 'Compline', vigil: 'Vigil', lauds: 'Lauds' };
        showToast(`Theme changed to ${themeNames[theme] || theme}`);
        await render();
      });
    });
    document.getElementById('default-unit')?.addEventListener('change', async event => {
      await setSetting('unit', event.currentTarget.value, {
        context: displayedUnitContext,
        mutationGeneration,
      });
      showToast('Default units updated');
      await render();
    });

    document.getElementById('libresync-save-preferences')?.addEventListener('click', handleSyncPreferences);
    document.getElementById('libresync-create-vault')?.addEventListener('click', handleCreateVault);
    document.getElementById('libresync-join-vault')?.addEventListener('click', handleJoinVault);
    document.getElementById('libresync-sync-now')?.addEventListener('click', handleSyncNow);
    document.getElementById('libresync-pair')?.addEventListener('click', handleCreatePairing);
    document.getElementById('libresync-devices')?.addEventListener('click', handleDeviceManager);
    document.getElementById('libresync-review-conflicts')?.addEventListener('click', handleConflictReview);
    document.getElementById('libresync-disconnect')?.addEventListener('click', handleSyncDisconnect);
    document.getElementById('libresync-delete-everywhere')?.addEventListener('click', handleDeleteSyncedData);
    document.getElementById('libresync-delete-vault')?.addEventListener('click', handleDeleteRemoteVault);

    unsubscribeSyncStatus?.();
    unsubscribeSyncStatus = syncClient.subscribeStatus(updateSyncStatus);

    // AI provider toggle visibility
    document.getElementById('ai-provider')?.addEventListener('change', (e) => {
      const provider = e.target.value;
      const keyFields = document.getElementById('ai-key-fields');
      const ollamaFields = document.getElementById('ai-ollama-fields');
      const privacyRow = document.getElementById('ai-privacy-row');
      if (keyFields) keyFields.style.display = (provider && provider !== 'ollama') ? '' : 'none';
      if (ollamaFields) ollamaFields.style.display = provider === 'ollama' ? '' : 'none';
      if (privacyRow) privacyRow.style.display = (provider && provider !== 'ollama') ? '' : 'none';
      if (provider !== aiProvider) {
        const consent = document.getElementById('ai-privacy-consent');
        if (consent) consent.checked = false;
      }
      const keyInput = document.getElementById('ai-api-key');
      if (keyInput && provider && provider !== 'ollama') {
        keyInput.placeholder = aiApiKeyConfigured && aiApiKeyProvider === provider
          ? 'Key saved — enter a new value to replace it'
          : 'Enter a key for this provider';
      }
    });

    document.getElementById('save-ai-btn')?.addEventListener('click', async () => {
      const provider = document.getElementById('ai-provider').value;
      const apiKey = document.getElementById('ai-api-key')?.value.trim() || '';
      const model = document.getElementById('ai-model')?.value.trim() || '';
      let ollamaUrl = document.getElementById('ai-ollama-url')?.value.trim() || 'http://localhost:11434';

      // The render-time provider binding is enough for an immediate hint.
      // saveAISettingsSafely revalidates the live credential and binding while
      // holding the lifecycle lock before it writes anything.
      const canReuseConfiguredKey = aiApiKeyConfigured && aiApiKeyProvider === provider;
      if (provider && provider !== 'ollama' && !apiKey && !canReuseConfiguredKey) {
        showToast('Please enter a new API key for ' + provider);
        return;
      }
      if (provider === 'ollama' && !model) {
        showToast('Enter the name of an installed Ollama model');
        return;
      }
      try {
        ollamaUrl = normalizeOllamaUrl(ollamaUrl);
      } catch (error) {
        if (provider === 'ollama') {
          showToast(error.message, 'error');
          return;
        }
        // Do not retain an unsafe dormant endpoint while another provider is selected.
        ollamaUrl = 'http://localhost:11434';
      }
      if (provider && provider !== 'ollama'
        && !document.getElementById('ai-privacy-consent')?.checked) {
        showToast('Confirm the remote AI data use before you save');
        return;
      }

      try {
        await saveAISettingsSafely({ provider, apiKey, model, ollamaUrl });
      } catch (error) {
        console.error('Could not save AI settings:', error);
        showToast(error?.code === 'AI_KEY_REQUIRED'
          ? error.message
          : 'AI settings could not be saved. No key was enabled for a different provider.', 'error', 7000);
        return;
      }
      showToast(provider ? `AI configured with ${provider}` : 'AI features disabled');
      render();
    });

    document.getElementById('save-usda-key-btn')?.addEventListener('click', async event => {
      const key = document.getElementById('usda-api-key').value.trim();
      if (!key) {
        showToast(usdaApiKeyConfigured ? 'Enter a new key, or use Remove API Key' : 'Enter an API key');
        return;
      }
      if (!document.getElementById('usda-privacy-consent')?.checked) {
        showToast('Confirm the USDA data use before you save');
        return;
      }
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await saveUsdaApiKey(key);
        showToast('USDA API key saved');
        if (container.isConnected) render();
      } catch (error) {
        console.error('Could not save USDA API key:', error);
        showToast('USDA API key could not be saved. Remote USDA search remains off.', 'error');
        if (button.isConnected) button.disabled = false;
      }
    });
    document.getElementById('remove-usda-key-btn')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await removeUsdaApiKey();
        showToast('USDA API key removed');
        if (container.isConnected) render();
      } catch (error) {
        console.error('Could not remove USDA API key:', error);
        showToast('USDA API key could not be removed. USDA search remains off.', 'error');
        if (button.isConnected) button.disabled = false;
      }
    });

    document.getElementById('export-btn')?.addEventListener('click', handleExport);
    document.getElementById('export-encrypted-btn')?.addEventListener('click', handleEncryptedExport);
    document.getElementById('import-btn')?.addEventListener('click', handleImport);
    document.getElementById('import-mfp-btn')?.addEventListener('click', handleMFPImport);
    document.getElementById('restore-migration-btn')?.addEventListener('click', handleMigrationRestore);
    document.getElementById('clear-btn')?.addEventListener('click', handleClear);

    document.getElementById('webdav-test')?.addEventListener('click', handleWebDAVTest);
    document.getElementById('webdav-enable')?.addEventListener('click', handleWebDAVReconsent);
    document.getElementById('webdav-push')?.addEventListener('click', handleWebDAVPush);
    document.getElementById('webdav-push-encrypted')?.addEventListener('click', handleEncryptedWebDAVPush);
    document.getElementById('webdav-pull')?.addEventListener('click', handleWebDAVPull);
    document.getElementById('webdav-pull-encrypted')?.addEventListener('click', handleEncryptedWebDAVPull);
    document.getElementById('webdav-disconnect')?.addEventListener('click', handleWebDAVDisconnect);
  }

  function syncFormValues() {
    return {
      consent: Boolean(document.getElementById('libresync-consent')?.checked),
      serverUrl: document.getElementById('libresync-server-url')?.value.trim() || '',
      deviceLabel: document.getElementById('libresync-device-label')?.value.trim() || '',
    };
  }

  function updateSyncStatus(status) {
    const statusElement = container.querySelector('#libresync-status');
    if (statusElement) {
      statusElement.textContent = status.connected
        ? syncStateLabel(status.automaticSync)
        : 'Not connected';
      statusElement.classList.toggle('connected', status.connected);
      statusElement.classList.toggle('disconnected', !status.connected);
    }
    const pending = container.querySelector('#libresync-pending');
    const quarantined = container.querySelector('#libresync-quarantined');
    const conflicts = container.querySelector('#libresync-conflicts');
    const lastSync = container.querySelector('#libresync-last-sync');
    const lastError = container.querySelector('#libresync-last-error');
    if (pending) pending.textContent = String(status.pendingCount);
    if (quarantined) quarantined.textContent = String(status.quarantinedCount);
    if (conflicts) conflicts.textContent = String(status.conflictCount);
    if (lastSync) lastSync.textContent = `Last successful sync: ${formatSyncDate(status.lastSuccessfulSync)}`;
    if (lastError) lastError.textContent = status.lastError ? `Last attempt: ${status.lastError}` : '';
  }

  async function handleSyncPreferences() {
    try {
      const values = syncFormValues();
      await setLibreSyncPreferences(values);
      showToast('LibreSync settings saved');
      await render();
    } catch (error) {
      showToast(error.message || 'Could not save LibreSync settings');
    }
  }

  async function handleCreateVault(event) {
    const button = event.currentTarget;
    const values = syncFormValues();
    if (!values.consent) {
      showToast('Confirm remote-data consent before creating a vault');
      return;
    }
    if (!values.serverUrl || !values.deviceLabel) {
      showToast('Enter a server URL and device label');
      return;
    }
    button.disabled = true;
    button.textContent = 'Creating and Uploading…';
    try {
      await setLibreSyncPreferences(values);
      await createLibreSyncVault(values);
      showToast('Encrypted LibreSync vault created');
      await render();
    } catch (error) {
      showToast(error.message || 'Could not create the LibreSync vault');
      button.disabled = false;
      button.textContent = 'Create New Vault';
    }
  }

  async function handleJoinVault(event) {
    const button = event.currentTarget;
    const values = syncFormValues();
    const pairingInput = document.getElementById('libresync-pairing-payload');
    const pairingPayload = pairingInput?.value.trim() || '';
    if (!values.consent) {
      showToast('Confirm remote-data consent before joining a vault');
      return;
    }
    if (!pairingPayload || !values.deviceLabel) {
      showToast('Enter the pairing payload and a device label');
      return;
    }
    // Remove the secret-bearing payload from the page before any network work.
    pairingInput.value = '';
    button.disabled = true;
    button.textContent = 'Backing Up and Joining…';
    try {
      await setLibreSyncPreferences(values);
      await joinLibreSyncVault(pairingPayload, { deviceLabel: values.deviceLabel });
      showToast('This device joined the encrypted vault');
      await render();
    } catch (error) {
      showToast(error.message || 'Could not join the LibreSync vault');
      button.disabled = false;
      button.textContent = 'Join Existing Vault';
    }
  }

  async function handleSyncNow(event) {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Syncing…';
    try {
      const result = await syncLibreLogNow();
      showToast(`Sync complete: ${result.pushed} sent, ${result.pulled} received`);
      await render();
    } catch (error) {
      showToast(error.message || 'Sync failed; local changes remain pending');
      button.disabled = false;
      button.textContent = 'Sync Now';
    }
  }

  async function copyPairingText(value, button) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const temporary = document.createElement('textarea');
      temporary.value = value;
      temporary.setAttribute('readonly', '');
      temporary.style.position = 'fixed';
      temporary.style.opacity = '0';
      document.body.appendChild(temporary);
      temporary.select();
      const copied = document.execCommand?.('copy');
      temporary.remove();
      button.focus();
      if (!copied) throw new Error('Clipboard access is unavailable');
    }
    showToast('Pairing payload copied');
  }

  async function handleCreatePairing(event) {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const client = await getLibreSyncClient();
      const bundle = await client.createInvitation(600);
      const modal = document.createElement('div');
      modal.className = 'modal-content confirm-modal';
      modal.innerHTML = `
        <div class="modal-header"><h2>Pair Another LibreLog Device</h2></div>
        <p class="confirm-message">This single-use invitation expires ${escapeHTML(formatSyncDate(bundle.expiresAt))}. It includes the vault key; keep it private and send it only to the device you are pairing.</p>
        <label class="setting-input"><span class="setting-label">Pairing URI</span>
          <textarea id="pairing-uri" rows="5" readonly spellcheck="false">${escapeHTML(bundle.uri)}</textarea>
        </label>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="cancel-btn">Close</button>
          <button class="btn btn-primary" id="copy-pairing-uri">Copy Pairing URI</button>
          <button class="btn btn-outline" id="copy-pairing-json">Copy JSON</button>
        </div>
      `;
      openModal(modal);
      document.getElementById('cancel-btn').addEventListener('click', closeModal);
      document.getElementById('copy-pairing-uri').addEventListener('click', copyEvent => (
        copyPairingText(bundle.uri, copyEvent.currentTarget)
      ));
      document.getElementById('copy-pairing-json').addEventListener('click', copyEvent => (
        copyPairingText(bundle.json, copyEvent.currentTarget)
      ));
    } catch (error) {
      showToast(error.message || 'Could not create a pairing invitation');
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'Pair Another Device';
      }
    }
  }

  async function handleDeviceManager() {
    try {
      const client = await getLibreSyncClient();
      const devices = await client.listDevices();
      const modal = document.createElement('div');
      modal.className = 'modal-content confirm-modal';
      modal.innerHTML = `
        <div class="modal-header"><h2>LibreSync Devices</h2></div>
        <p class="confirm-message">Revocation blocks future server access. It cannot erase data or invalidate a vault key already downloaded by that device.</p>
        <div class="settings-group">
          ${devices.map(device => `
            <div class="about-item">
              <span><strong>${escapeHTML(device.label)}</strong><br><span class="setting-hint">${device.current ? 'This device' : escapeHTML(device.deviceId)}${device.revokedAt ? ' — revoked' : ''}</span></span>
              ${!device.current && !device.revokedAt ? `<button class="btn btn-outline btn-danger btn-small revoke-sync-device" data-device-id="${escapeHTML(device.deviceId)}">Revoke</button>` : ''}
            </div>
          `).join('')}
        </div>
        <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Close</button></div>
      `;
      openModal(modal);
      document.getElementById('cancel-btn').addEventListener('click', closeModal);
      document.querySelectorAll('.revoke-sync-device').forEach(revokeButton => {
        revokeButton.addEventListener('click', async revokeEvent => {
          const deviceId = revokeEvent.currentTarget.dataset.deviceId;
          if (!confirm('Revoke this device from future LibreSync access?')) return;
          revokeEvent.currentTarget.disabled = true;
          try {
            await client.revokeDevice(deviceId);
            showToast('Device revoked');
            closeModal();
            await handleDeviceManager();
          } catch (error) {
            showToast(error.message || 'Could not revoke the device');
            revokeEvent.currentTarget.disabled = false;
          }
        });
      });
    } catch (error) {
      showToast(error.message || 'Could not load LibreSync devices');
    }
  }

  async function resolveDisplayedConflict(client, conflict, resolution, button) {
    button.disabled = true;
    try {
      await client.resolveConflict(conflict.entityType, conflict.entityId, resolution);
      try {
        await client.sync();
        showToast('Conflict resolved and synchronized');
      } catch {
        showToast('Conflict resolved locally; synchronization remains pending');
      }
      closeModal();
      await render();
    } catch (error) {
      showToast(error.message || 'Could not resolve the conflict');
      button.disabled = false;
    }
  }

  async function handleConflictReview() {
    try {
      const client = await getLibreSyncClient();
      const conflicts = await client.listConflicts();
      if (!conflicts.length) {
        showToast('No unresolved LibreSync conflicts');
        return;
      }
      const modal = document.createElement('div');
      modal.className = 'modal-content';
      modal.innerHTML = `
        <div class="modal-header"><h2>Review Sync Conflicts</h2></div>
        <p class="confirm-message">Each alternative remains recoverable until you choose one or save an intentional merged value. Times are shown only for context; they do not decide which change wins.</p>
        <div class="settings-group">
          ${conflicts.map((conflict, conflictIndex) => `
            <section class="settings-section sync-conflict" data-conflict-index="${conflictIndex}">
              <h3>${escapeHTML(syncEntityLabel(conflict.entityType, conflict.entityId))}</h3>
              <p class="setting-hint">Stable ID: ${escapeHTML(conflict.entityId)}</p>
              ${conflict.projection.alternatives.map((alternative, alternativeIndex) => `
                <div class="setting-input">
                  <span class="setting-label">Version ${alternativeIndex + 1} — ${alternative.kind === 'delete' ? 'Deleted' : 'Saved'}
                    <span class="setting-hint">Authored ${escapeHTML(formatSyncDate(alternative.authoredAt))}</span>
                  </span>
                  <pre class="setting-hint">${alternative.kind === 'delete' ? 'Deleted record' : escapeHTML(JSON.stringify(alternative.payload, null, 2))}</pre>
                  <button class="btn btn-outline btn-small keep-conflict-version" data-conflict-index="${conflictIndex}" data-alternative-index="${alternativeIndex}">Keep This Version</button>
                </div>
              `).join('')}
              <label class="setting-input">
                <span class="setting-label">Intentional Merged Value (JSON)</span>
                <textarea id="conflict-merge-${conflictIndex}" rows="8" spellcheck="false">${conflict.projection.kind === 'put' ? escapeHTML(JSON.stringify(conflict.projection.payload, null, 2)) : ''}</textarea>
              </label>
              <button class="btn btn-primary btn-small merge-conflict-version" data-conflict-index="${conflictIndex}">Save Merged Value</button>
            </section>
          `).join('')}
        </div>
        <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Close</button></div>
      `;
      openModal(modal);
      document.getElementById('cancel-btn').addEventListener('click', closeModal);
      document.querySelectorAll('.keep-conflict-version').forEach(versionButton => {
        versionButton.addEventListener('click', event => {
          const conflict = conflicts[Number(event.currentTarget.dataset.conflictIndex)];
          const alternative = conflict.projection.alternatives[
            Number(event.currentTarget.dataset.alternativeIndex)
          ];
          const resolution = alternative.kind === 'delete'
            ? { kind: 'delete' }
            : { kind: 'put', payload: structuredClone(alternative.payload) };
          resolveDisplayedConflict(client, conflict, resolution, event.currentTarget);
        });
      });
      document.querySelectorAll('.merge-conflict-version').forEach(mergeButton => {
        mergeButton.addEventListener('click', event => {
          const conflictIndex = Number(event.currentTarget.dataset.conflictIndex);
          const conflict = conflicts[conflictIndex];
          const text = document.getElementById(`conflict-merge-${conflictIndex}`).value;
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            showToast('Merged value must be valid JSON');
            return;
          }
          resolveDisplayedConflict(
            client,
            conflict,
            { kind: 'put', payload },
            event.currentTarget,
          );
        });
      });
    } catch (error) {
      showToast(error.message || 'Could not load LibreSync conflicts');
    }
  }

  function openSyncConfirmation({
    title,
    message,
    confirmLabel,
    requiredText = '',
    workingLabel = 'Working…',
    failureMessage = '',
    action,
  }) {
    const modal = document.createElement('div');
    modal.className = 'modal-content confirm-modal';
    modal.innerHTML = `
      <div class="modal-header"><h2>${escapeHTML(title)}</h2></div>
      <p class="confirm-message">${escapeHTML(message)}</p>
      ${requiredText ? `<label class="setting-input"><span class="setting-label">Type ${escapeHTML(requiredText)} to confirm</span><input type="text" id="sync-confirmation" autocomplete="off"></label>` : ''}
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-danger" id="confirm-btn">${escapeHTML(confirmLabel)}</button>
      </div>
    `;
    let actionInProgress = false;
    const dialog = openModal(modal, { canClose: () => !actionInProgress });
    const cancelButton = dialog.querySelector('#cancel-btn');
    const confirmButton = dialog.querySelector('#confirm-btn');
    cancelButton.addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
    confirmButton.addEventListener('click', async event => {
      if (actionInProgress) return;
      const confirmation = dialog.querySelector('#sync-confirmation')?.value || '';
      if (requiredText && confirmation !== requiredText) {
        showToast(`Type ${requiredText} exactly to continue`);
        return;
      }
      actionInProgress = true;
      const button = event.currentTarget;
      cancelButton.disabled = true;
      button.disabled = true;
      button.textContent = workingLabel;
      try {
        await action(confirmation);
        closeModal({ target: dialog, force: true, reason: 'completed' });
      } catch (error) {
        showToast(failureMessage || error.message || 'LibreSync action failed');
        actionInProgress = false;
        cancelButton.disabled = false;
        button.disabled = false;
        button.textContent = confirmLabel;
      }
    });
  }

  function handleSyncDisconnect() {
    openSyncConfirmation({
      title: 'Disconnect This Device?',
      message: 'LibreLog data stays on this device and in the remote vault. This clears this device’s sync key, credential, cursors, outbox, inbox, and conflicts, then rotates its local device identity. Re-pairing registers a new device; the old server entry remains until an authorized device revokes it or the vault is deleted.',
      confirmLabel: 'Disconnect and Keep Data',
      action: async () => {
        await disconnectLibreSync();
        showToast('LibreSync disconnected; local data was preserved');
        await render();
      },
    });
  }

  function handleDeleteSyncedData() {
    openSyncConfirmation({
      title: 'Delete Synchronized App Data Everywhere?',
      message: 'LibreLog will first sync, then send tombstones for foods, meals, recipes, measurements, notes, templates, goals, theme, and units. Connected replicas delete them on their next sync. A truly concurrent offline edit remains recoverable as a conflict. Local-only credentials and backups are not deleted.',
      confirmLabel: 'Delete Synced Data Everywhere',
      requiredText: 'DELETE EVERYWHERE',
      action: async () => {
        const count = await deleteLibreLogDataEverywhere();
        showToast(`${count} synchronized records deleted`);
        await render();
      },
    });
  }

  async function handleDeleteRemoteVault() {
    const client = await getLibreSyncClient();
    const status = await client.getStatus();
    if (!status.vaultId) return;
    const requiredText = `delete:${status.vaultId}`;
    openSyncConfirmation({
      title: 'Permanently Delete Remote Vault?',
      message: 'This irreversibly removes the remote vault, encrypted operations, device records, invitations, and server credentials. Data already downloaded to devices remains there. Local LibreLog data on this device is preserved and disconnected.',
      confirmLabel: 'Permanently Delete Vault',
      requiredText,
      action: async confirmation => {
        await deleteLibreSyncVault(confirmation);
        showToast('Remote LibreSync vault permanently deleted');
        await render();
      },
    });
  }

  async function saveGoals({ context, mutationGeneration } = {}) {
    const calorieTarget = Number(document.getElementById('goal-calories').value);
    const proteinG = Number(document.getElementById('goal-protein').value);
    const carbG = Number(document.getElementById('goal-carbs').value);
    const fatG = Number(document.getElementById('goal-fat').value);
    const fiberG = Number(document.getElementById('goal-fiber').value);
    const sodiumMg = Number(document.getElementById('goal-sodium').value);

    await setGoals(
      { calorieTarget, proteinG, carbG, fatG, fiberG, sodiumMg },
      { context, mutationGeneration },
    );
    showToast('Goals saved');
    await render();
  }

  function handleProtectCredentials() {
    openPassphraseAction({
      title: 'Encrypt Stored Credentials',
      message: 'This passphrase encrypts current and future credentials. LibreLog cannot recover it.',
      confirmPassphrase: true,
      confirmLabel: 'Encrypt Credentials',
      action: async passphrase => {
        await enableCredentialEncryption(passphrase);
        showToast('Credential protection enabled');
        render();
      },
    });
  }

  function handleUnlockCredentials() {
    openPassphraseAction({
      title: 'Unlock Credentials',
      message: 'Enter the credential-protection passphrase. Credentials stay unlocked in memory until you lock them or reload the app.',
      confirmLabel: 'Unlock Credentials',
      action: async passphrase => {
        await unlockCredentialStore(passphrase);
        showToast('Credentials unlocked');
        render();
      },
    });
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

  function handleEncryptedExport() {
    openPassphraseAction({
      title: 'Export Encrypted Data',
      message: 'Use at least 8 characters. LibreLog cannot recover a lost passphrase.',
      confirmPassphrase: true,
      confirmLabel: 'Export Encrypted Data',
      action: async passphrase => {
        await exportEncryptedData(passphrase);
        showToast('Encrypted data exported');
      },
    });
  }

  function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const data = await prepareImportData(file);
        openImportPreview(data, file.name);
      } catch (err) {
        if (err.code === 'BACKUP_PASSPHRASE_REQUIRED') {
          openPassphraseAction({
            title: 'Unlock Encrypted Backup',
            message: 'Enter the passphrase for this backup.',
            confirmLabel: 'Unlock and Review',
            action: async passphrase => {
              const data = await prepareImportData(file, { passphrase });
              setTimeout(() => openImportPreview(data, file.name), 200);
            },
          });
          return;
        }
        console.error('Import failed:', err);
        showToast(`Import failed: ${err.message || 'check the file format'}`);
      }
    });
    input.click();
  }

  function openImportPreview(data, filename) {
    const summary = summarizeImportData(data);
    const labels = {
      foods: 'foods',
      meals: 'meals',
      recipes: 'recipes',
      measurements: 'measurements',
      settings: 'settings',
    };
    const countItems = Object.entries(summary.counts)
      .map(([store, count]) => `<li><strong>${count}</strong> ${labels[store] || store}</li>`)
      .join('');
    const exported = summary.exportedAt
      ? new Date(summary.exportedAt).toLocaleString()
      : 'Date not provided';

    const modal = document.createElement('div');
    modal.className = 'modal-content confirm-modal';
    modal.innerHTML = `
      <div class="modal-header"><h2>Review Import</h2></div>
      <p class="confirm-message"><strong>${escapeHTML(filename || 'LibreLog backup')}</strong><br>${escapeHTML(exported)}</p>
      <ul class="import-summary">${countItems}</ul>
      <p class="setting-hint"><strong>Merge (recommended)</strong> adds records that are not already on this device. Existing local records win if IDs match.</p>
      <p class="setting-hint"><strong>Full replacement</strong> replaces local meals, foods, recipes, measurements, and non-secret settings. LibreLog must verify a safety backup first.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-danger" id="replace-import-btn">Full Replacement</button>
        <button class="btn btn-primary" id="merge-import-btn">Merge (Recommended)</button>
      </div>
    `;
    let importInProgress = false;
    const dialog = openModal(modal, { canClose: () => !importInProgress });

    const mergeButton = dialog.querySelector('#merge-import-btn');
    const replaceButton = dialog.querySelector('#replace-import-btn');
    const cancelButton = dialog.querySelector('#cancel-btn');
    cancelButton.addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));

    async function runImport(merge, button) {
      if (importInProgress) return;
      importInProgress = true;
      mergeButton.disabled = true;
      replaceButton.disabled = true;
      cancelButton.disabled = true;
      button.textContent = merge ? 'Merging…' : 'Making Safety Backup…';
      try {
        if (merge) await importAllData(data, true);
        else await replaceAllDataWithSafetyBackup(data);
        closeModal({ target: dialog, force: true, reason: 'completed' });
        showToast(merge
          ? `Import merged ${summary.totalRecords} records; existing local records were kept`
          : `Import replaced local data with ${summary.totalRecords} records`);
        if (container.isConnected) render();
      } catch (err) {
        console.error('Import failed:', err);
        showToast(err.message || 'Import failed. Local data was not changed.');
        importInProgress = false;
        mergeButton.disabled = false;
        replaceButton.disabled = false;
        cancelButton.disabled = false;
        mergeButton.textContent = 'Merge (Recommended)';
        replaceButton.textContent = 'Full Replacement';
      }
    }

    mergeButton.addEventListener('click', event => runImport(true, event.currentTarget));
    replaceButton.addEventListener('click', event => runImport(false, event.currentTarget));
  }

  function handleClear() {
    openSyncConfirmation({
      title: 'Clear This Device and Disconnect?',
      message: 'This deletes LibreLog data, local-only settings, credentials, backups, pending changes, and LibreSync connection state from this device. It does not delete the remote vault or data already on other devices. Unsynced local changes cannot be recovered; an authorized device is required to pair this device again.',
      confirmLabel: 'Clear This Device',
      requiredText: 'CLEAR THIS DEVICE',
      workingLabel: 'Clearing…',
      failureMessage: 'Failed to clear this device. Your current data was preserved when possible.',
      action: async () => {
        try {
          await clearThisDeviceAndDisconnect();
        } catch (error) {
          try {
            // The guarded clear restores a recovery snapshot if IndexedDB fails.
            // Resume its recurring schedule before returning the live app.
            await initAutoBackup();
          } catch (backupError) {
            console.warn('Could not resume automatic backups after failed device clear:', backupError);
          }
          throw error;
        }
        showToast('This device was cleared and disconnected');
        setTimeout(() => {
          window.location.reload();
        }, 500);
      },
    });
  }

  function handleMigrationRestore() {
    const timestamp = document.getElementById('migration-backup')?.value;
    if (!timestamp) return;

    const modal = document.createElement('div');
    modal.className = 'modal-content confirm-modal';
    modal.innerHTML = `
      <div class="modal-header"><h2>Restore Migration Checkpoint?</h2></div>
      <p class="confirm-message">This replaces local meals, foods, recipes, measurements, and non-secret settings with the selected checkpoint. Local credentials stay on this device.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-danger" id="confirm-btn">Restore Checkpoint</button>
      </div>
    `;
    let restoreInProgress = false;
    const dialog = openModal(modal, { canClose: () => !restoreInProgress });
    const cancelButton = dialog.querySelector('#cancel-btn');
    cancelButton.addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
    dialog.querySelector('#confirm-btn').addEventListener('click', async (event) => {
      if (restoreInProgress) return;
      restoreInProgress = true;
      const button = event.currentTarget;
      button.disabled = true;
      cancelButton.disabled = true;
      button.textContent = 'Restoring...';
      try {
        await replaceAllDataWithSafetyBackup(getMigrationBackupData(timestamp));
        closeModal({ target: dialog, force: true, reason: 'completed' });
        showToast('Migration checkpoint restored');
        if (container.isConnected) render();
      } catch (err) {
        console.error('Checkpoint restore failed:', err);
        showToast('Checkpoint restore failed. Local data was not changed.');
        restoreInProgress = false;
        button.disabled = false;
        cancelButton.disabled = false;
        button.textContent = 'Restore Checkpoint';
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
    if (!document.getElementById('webdav-privacy-consent')?.checked) {
      showToast('Confirm the WebDAV data use before you connect');
      return;
    }

    const btn = document.getElementById('webdav-test');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Testing...';

    try {
      await setWebDavConfig(url, username, password, { confirmRemoteDataUse: true });
      showToast('Connection successful');
      render();
    } catch (err) {
      console.error('WebDAV test failed:', err);
      showToast(err.message || 'Connection error. Check your credentials and URL.', 'error', 7000);
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = 'Connect';
      }
    }
  }

  async function handleWebDAVReconsent() {
    if (!document.getElementById('webdav-existing-privacy-consent')?.checked) {
      showToast('Confirm the WebDAV data use before you enable backups');
      return;
    }
    const button = document.getElementById('webdav-enable');
    button.disabled = true;
    try {
      await activateStoredWebDavConfig({ confirmRemoteDataUse: true });
      showToast('WebDAV backup enabled');
      render();
    } catch (error) {
      console.error('Could not enable saved WebDAV configuration:', error);
      showToast(error.message || 'Could not enable WebDAV backup.', 'error', 7000);
      if (button.isConnected) button.disabled = false;
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

  function handleEncryptedWebDAVPush() {
    openPassphraseAction({
      title: 'Create Encrypted WebDAV Backup',
      message: 'Use at least 8 characters. LibreLog cannot recover a lost passphrase.',
      confirmPassphrase: true,
      confirmLabel: 'Create Encrypted Backup',
      action: async passphrase => {
        await pushToWebDav({ passphrase });
        showToast('Encrypted WebDAV backup created');
      },
    });
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
    let restoreInProgress = false;
    const dialog = openModal(modal, { canClose: () => !restoreInProgress });
    const cancelButton = dialog.querySelector('#cancel-btn');
    cancelButton.addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
    dialog.querySelector('#confirm-btn').addEventListener('click', async (event) => {
      if (restoreInProgress) return;
      restoreInProgress = true;
      cancelButton.disabled = true;
      try {
        await performWebDAVPull(event.currentTarget, dialog);
      } finally {
        restoreInProgress = false;
        if (cancelButton.isConnected) cancelButton.disabled = false;
      }
    });
  }

  async function performWebDAVPull(btn, dialog) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Restoring...';

    try {
      await pullFromWebDav();
      closeModal({ target: dialog, force: true, reason: 'completed' });
      showToast('WebDAV backup restored');
      if (container.isConnected) render();
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

  function handleEncryptedWebDAVPull() {
    openPassphraseAction({
      title: 'Restore Encrypted WebDAV Backup',
      message: 'This replaces local data with the encrypted server backup. Local credentials stay on this device.',
      confirmLabel: 'Unlock and Restore',
      action: async passphrase => {
        await pullFromWebDav({ passphrase });
        showToast('Encrypted WebDAV backup restored');
        if (container.isConnected) render();
      },
    });
  }

  function openPassphraseAction({
    title,
    message,
    confirmPassphrase = false,
    confirmLabel,
    action,
  }) {
    const modal = document.createElement('div');
    modal.className = 'modal-content confirm-modal';
    modal.innerHTML = `
      <div class="modal-header"><h2>${escapeHTML(title)}</h2></div>
      <p class="confirm-message">${escapeHTML(message)}</p>
      <label class="setting-input">
        <span class="setting-label">Passphrase</span>
        <input type="password" id="backup-passphrase" name="backup-passphrase" minlength="8" autocomplete="new-password">
      </label>
      ${confirmPassphrase ? `
        <label class="setting-input">
          <span class="setting-label">Confirm Passphrase</span>
          <input type="password" id="backup-passphrase-confirm" name="backup-passphrase-confirm" minlength="8" autocomplete="new-password">
        </label>
      ` : ''}
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="confirm-btn">${escapeHTML(confirmLabel)}</button>
      </div>
    `;
    let actionInProgress = false;
    const dialog = openModal(modal, { canClose: () => !actionInProgress });
    const passphraseInput = dialog.querySelector('#backup-passphrase');
    const confirmationInput = dialog.querySelector('#backup-passphrase-confirm');
    const cancelButton = dialog.querySelector('#cancel-btn');
    passphraseInput.focus();
    cancelButton.addEventListener('click', () => closeModal({ target: dialog, reason: 'cancel' }));
    dialog.querySelector('#confirm-btn').addEventListener('click', async (event) => {
      if (actionInProgress) return;
      const passphrase = passphraseInput.value;
      const confirmation = confirmationInput?.value;
      if (passphrase.length < 8) {
        showToast('Passphrase must contain at least 8 characters');
        return;
      }
      if (confirmPassphrase && passphrase !== confirmation) {
        showToast('Passphrases do not match');
        return;
      }

      const button = event.currentTarget;
      actionInProgress = true;
      button.disabled = true;
      cancelButton.disabled = true;
      passphraseInput.disabled = true;
      if (confirmationInput) confirmationInput.disabled = true;
      button.textContent = 'Working...';
      try {
        await action(passphrase);
        passphraseInput.value = '';
        if (confirmationInput) confirmationInput.value = '';
        closeModal({ target: dialog, force: true, reason: 'completed' });
      } catch (err) {
        console.error('Encrypted backup operation failed:', err);
        showToast(err.message || 'Encrypted backup operation failed');
        actionInProgress = false;
        button.disabled = false;
        cancelButton.disabled = false;
        passphraseInput.disabled = false;
        if (confirmationInput) confirmationInput.disabled = false;
        button.textContent = confirmLabel;
      }
    });
  }

  async function handleWebDAVDisconnect() {
    await disconnectWebDav();
    showToast('WebDAV disconnected');
    render();
  }

  await render();
  return () => unsubscribeSyncStatus?.();
}

function syncStateLabel(state) {
  return ({
    stopped: 'Connected — manual sync',
    idle: 'Connected — up to date',
    syncing: 'Synchronizing…',
    offline: 'Offline — changes stay pending',
    error: 'Connected — last attempt failed',
  })[state] || 'Connected';
}

function formatSyncDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function syncEntityLabel(entityType, entityId = '') {
  if (entityType === 'settings') {
    if (entityId.startsWith('note_')) return 'Daily note';
    if (entityId.startsWith('template_')) return 'Meal template';
    if (entityId === 'nutritionGoals') return 'Nutrition goals';
    if (entityId === 'theme') return 'Theme';
    if (entityId === 'unit') return 'Units';
  }
  return ({
    foods: 'Food',
    meals: 'Meal',
    recipes: 'Recipe',
    measurements: 'Measurement',
    settings: 'Preference',
  })[entityType] || entityType;
}

function computeMonthlyUsage(log) {
  if (!Array.isArray(log) || log.length === 0) return { count: 0, tokens: 0, cost: 0 };
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thisMonth = log.filter(entry => entry
    && typeof entry === 'object'
    && typeof entry.date === 'string'
    && entry.date >= monthStart);
  const safeNumber = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0);
  return {
    count: thisMonth.length,
    tokens: thisMonth.reduce((sum, entry) => sum + safeNumber(entry.tokens), 0),
    cost: thisMonth.reduce((sum, entry) => sum + safeNumber(entry.cost), 0),
  };
}

function formatCheckpointDate(timestamp) {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return 'Unknown date';
  return value.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
