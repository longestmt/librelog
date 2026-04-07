/**
 * search.js — Unified food search & add page
 * Modes: text search, barcode scan, AI photo, AI voice, AI text
 */

import { getById, put } from '../data/db.js';
import { searchFoods, getRecentFoods, getFavoriteFoods } from '../engine/food-search.js';
import { lookupBarcode } from '../integrations/openfoodfacts.js';
import { todayStr } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { getUnitsForFood, getNutritionMultiplier } from '../utils/units.js';

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
const MODES = [
  { key: 'search', label: 'Search', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' },
  { key: 'scan', label: 'Scan', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" x2="17" y1="12" y2="12"/></svg>' },
  { key: 'ai', label: 'AI', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' },
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

export function renderSearchPage(container, queryString) {
  const params = new URLSearchParams(queryString);
  const mealTypeParam = params.get('meal') || 'lunch';
  let mealType = mealTypeParam.charAt(0).toUpperCase() + mealTypeParam.slice(1);
  let mode = params.get('mode') || 'search';

  let searchQuery = '';
  let searchResults = [];
  let searchTimeout;
  let searchSources = { local: true, usda: true, off: true };
  let offPage = 1;
  let usdaPage = 1;

  // Scanner state
  let cameraStarted = false;

  // AI state
  let aiProcessing = false;
  let aiResults = null;
  let clarificationData = null;
  let aiAttachedPhoto = null;
  let aiTextValue = '';
  let recorder = null;
  let isRecording = false;
  let amplitudeInterval = null;

  async function render() {
    // Determine which modes to show based on AI config
    const ai = await loadAI();
    const aiConfigured = ai ? await ai.isAIConfigured() : false;
    let aiProvider = null;
    if (aiConfigured && ai) { const cfg = await ai.getAIConfig(); aiProvider = cfg.provider; }

    const visibleModes = MODES.filter(m => {
      if (m.key === 'ai') return aiConfigured;
      return true;
    });

    // If current mode is hidden, fall back to search
    if (!visibleModes.some(m => m.key === mode)) mode = 'search';

    container.innerHTML = `
      <div class="search-page" role="main" aria-label="Add food">
        <!-- Header: mode tabs + meal type badge in one row -->
        <div class="search-top-bar">
          <div class="search-mode-tabs" role="tablist" aria-label="Add food method">
            ${visibleModes.map(m => `
              <button class="search-mode-tab ${mode === m.key ? 'active' : ''}" data-mode="${m.key}" role="tab" aria-selected="${mode === m.key}" aria-label="${m.label}">
                ${m.icon}
                <span>${m.label}</span>
              </button>
            `).join('')}
          </div>
          <button class="meal-type-badge" id="meal-type-toggle" aria-label="Logging to ${mealType}. Tap to change.">${mealType}</button>
        </div>

        <!-- Mode content -->
        <div class="search-mode-content" id="mode-content" role="tabpanel">
        </div>
      </div>
    `;

    // Meal type toggle
    document.getElementById('meal-type-toggle')?.addEventListener('click', () => {
      const idx = MEAL_TYPES.indexOf(mealType);
      mealType = MEAL_TYPES[(idx + 1) % MEAL_TYPES.length];
      document.getElementById('meal-type-toggle').textContent = mealType;
      document.getElementById('meal-type-toggle').setAttribute('aria-label', `Logging to ${mealType}. Tap to change.`);
    });

    // Mode tabs
    document.querySelectorAll('.search-mode-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        stopScanner();
        stopVoice();
        mode = btn.dataset.mode;
        aiResults = null;
        aiProcessing = false;
        clarificationData = null;
        aiAttachedPhoto = null;
        aiTextValue = '';
        renderModeContent();
        document.querySelectorAll('.search-mode-tab').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === mode);
          b.setAttribute('aria-selected', b.dataset.mode === mode);
        });
      });
    });

    renderModeContent();
  }

  async function renderModeContent() {
    const el = document.getElementById('mode-content');
    if (!el) return;

    switch (mode) {
      case 'search': await renderSearchMode(el); break;
      case 'scan': renderScanMode(el); break;
      case 'ai': renderAIMode(el); break;
    }
  }

  // ===== SEARCH MODE =====
  async function renderSearchMode(el) {
    const recentFoods = await getRecentFoods();
    const frequentFoods = await getFavoriteFoods();

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
        <button class="source-filter-chip ${searchSources.local ? 'active' : ''}" data-source="local">Local</button>
        <button class="source-filter-chip ${searchSources.usda ? 'active' : ''}" data-source="usda">USDA</button>
        <button class="source-filter-chip ${searchSources.off ? 'active' : ''}" data-source="off">OFF</button>
      </div>
      <div id="search-results-area">
        ${recentFoods.length > 0 ? `<section class="search-section"><h3 class="section-title">Recent Foods</h3><div class="food-results">${recentFoods.map(f => renderFoodResult(f)).join('')}</div></section>` : ''}
        ${frequentFoods.length > 0 ? `<section class="search-section"><h3 class="section-title">Frequent Foods</h3><div class="food-results">${frequentFoods.map(f => renderFoodResult(f)).join('')}</div></section>` : ''}
        ${recentFoods.length === 0 && frequentFoods.length === 0 ? '<div class="search-empty"><p>Search for foods to log</p></div>' : ''}
        <div class="search-actions"><button class="btn btn-outline" id="add-custom-food-btn">Add Custom Food</button></div>
      </div>
    `;

    const searchInput = document.getElementById('food-search-input');
    searchInput.focus();
    bindFoodResultEvents([...recentFoods, ...frequentFoods]);
    document.getElementById('add-custom-food-btn')?.addEventListener('click', openCustomFoodForm);

    // Filter toggle
    const filterBtn = document.getElementById('filter-toggle-btn');
    const filterPanel = document.getElementById('source-filters');
    filterBtn?.addEventListener('click', () => {
      const open = filterPanel.classList.toggle('hidden');
      filterBtn.setAttribute('aria-expanded', !open);
    });

    // Source filter chips
    document.querySelectorAll('.source-filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const source = chip.dataset.source;
        searchSources[source] = !searchSources[source];
        if (!searchSources.local && !searchSources.usda && !searchSources.off) {
          searchSources[source] = true;
          return;
        }
        chip.classList.toggle('active', searchSources[source]);
        filterBtn.classList.toggle('has-filter', !searchSources.local || !searchSources.usda || !searchSources.off);
        offPage = 1;
        usdaPage = 1;
        if (searchQuery) performTextSearch();
      });
    });

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      clearTimeout(searchTimeout);
      if (!searchQuery) { renderSearchMode(el); return; }
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
    const area = document.getElementById('search-results-area');
    if (!area) return;
    if (!loadMore) {
      area.innerHTML = '<div class="search-loading">Searching...</div>';
    }
    try {
      const newResults = await searchFoods(searchQuery, {
        localOnly: false,
        limit: 50,
        sources: searchSources,
        offPage,
        usdaPage
      });
      if (loadMore) {
        searchResults = [...searchResults, ...newResults];
      } else {
        searchResults = newResults;
      }
      if (!searchResults?.length) {
        area.innerHTML = `<div class="search-empty"><p>No foods found for "${escapeHTML(searchQuery)}"</p></div><div class="search-actions"><button class="btn btn-outline" id="add-custom-food-btn">Add Custom Food</button></div>`;
        document.getElementById('add-custom-food-btn')?.addEventListener('click', openCustomFoodForm);
        return;
      }
      const hasRemoteSources = searchSources.usda || searchSources.off;
      const loadMoreBtn = hasRemoteSources ? '<button class="btn btn-outline" id="load-more-btn">Load More</button>' : '';
      area.innerHTML = `<section class="search-section"><h3 class="section-title">Results</h3><div class="food-results">${searchResults.map(f => renderFoodResult(f)).join('')}</div></section><div class="search-actions">${loadMoreBtn}<button class="btn btn-outline" id="add-custom-food-btn">Add Custom Food</button></div>`;
      bindFoodResultEvents(searchResults);
      document.getElementById('add-custom-food-btn')?.addEventListener('click', openCustomFoodForm);
      document.getElementById('load-more-btn')?.addEventListener('click', () => {
        if (searchSources.off) offPage++;
        if (searchSources.usda) usdaPage++;
        performTextSearch(true);
      });
    } catch (err) {
      console.error('Search error:', err);
      area.innerHTML = '<div class="search-error"><p>Search failed. Please try again.</p></div>';
    }
  }

  async function performBarcodeLookup(code) {
    const area = document.getElementById('search-results-area');
    if (!area) return;
    area.innerHTML = '<div class="search-loading">Looking up barcode...</div>';
    try {
      const food = await lookupBarcode(code);
      if (!food) { area.innerHTML = `<div class="search-empty"><p>Barcode <strong>${escapeHTML(code)}</strong> not found</p></div>`; return; }
      area.innerHTML = `<section class="search-section"><h3 class="section-title">Barcode Match</h3><div class="food-results">${renderFoodResult(food)}</div></section>`;
      bindFoodResultEvents([food]);
    } catch (err) {
      area.innerHTML = '<div class="search-error"><p>Barcode lookup failed</p></div>';
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
    const Q = await loadQuagga();
    if (!Q) { showToast('Camera scanning not available'); return; }
    const viewport = document.getElementById('scanner-viewport');
    document.getElementById('start-camera-btn').style.display = 'none';
    document.getElementById('stop-camera-btn').style.display = '';
    document.getElementById('scanner-reticle').style.display = '';

    try {
      await new Promise((res, rej) => {
        Q.init({ inputStream: { type: 'LiveStream', target: viewport, constraints: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } } }, decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'] }, locate: true, frequency: 10 }, err => err ? rej(err) : res());
      });
      Q.start();
      cameraStarted = true;
      Q.onDetected(result => {
        const code = result?.codeResult?.code;
        if (code) { stopScanner(); handleBarcodeResult(code); }
      });
    } catch (err) {
      console.error('Camera error:', err);
      showToast('Could not access camera');
      stopScanner();
    }
  }

  function stopScanner() {
    if (Quagga && cameraStarted) { try { Quagga.stop(); } catch {} cameraStarted = false; }
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
    resultDiv.innerHTML = '<div class="search-loading">Looking up barcode...</div>';
    try {
      const food = await lookupBarcode(code);
      if (!food) { resultDiv.innerHTML = `<div class="search-empty"><p>Barcode <strong>${escapeHTML(code)}</strong> not found</p></div>`; return; }
      resultDiv.innerHTML = `<div class="food-results">${renderFoodResult(food)}</div>`;
      bindFoodResultEvents([food]);
    } catch { resultDiv.innerHTML = '<div class="search-error"><p>Lookup failed</p></div>'; }
  }

  // ===== UNIFIED AI MODE =====
  function renderAIMode(el) {
    if (aiProcessing) { el.innerHTML = renderAIProcessing(aiAttachedPhoto ? 'photo' : 'description'); return; }
    if (clarificationData?.questions?.length) { el.innerHTML = renderClarificationUI(); wireClarificationEvents(); return; }
    if (aiResults) { el.innerHTML = renderAIResults(); wireAIResultEvents(); return; }

    const showVoice = aiProvider === 'openai';

    el.innerHTML = `
      <div class="ai-unified-input">
        ${aiAttachedPhoto ? `
          <div class="ai-attached-photo">
            <img src="${aiAttachedPhoto}" alt="Attached meal photo">
            <button class="ai-photo-remove" id="ai-remove-photo" aria-label="Remove photo">&#10005;</button>
          </div>
        ` : ''}
        <textarea class="ai-text-area" id="ai-text-input" rows="3" placeholder="Describe what you ate, attach a photo, or both..." aria-label="Describe your meal">${escapeHTML(aiTextValue)}</textarea>
        <div class="ai-input-actions">
          <button class="btn btn-secondary btn-small" id="ai-photo-btn" aria-label="Attach photo">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            Photo
          </button>
          ${showVoice ? `
            <button class="btn btn-secondary btn-small ${isRecording ? 'recording' : ''}" id="ai-voice-btn" aria-label="${isRecording ? 'Stop recording' : 'Record voice'}">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="${isRecording ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                ${isRecording ? '<rect x="6" y="6" width="12" height="12" rx="2"/>' : '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>'}
              </svg>
              ${isRecording ? 'Stop' : 'Voice'}
            </button>
          ` : ''}
          <button class="btn btn-primary btn-small" id="ai-submit-btn">Analyze</button>
        </div>
        ${isRecording ? `<div class="ai-recording-indicator"><div class="waveform-bars" id="voice-waveform">${Array(12).fill('<div class="waveform-bar"></div>').join('')}</div><p class="ai-voice-hint">Listening... tap Stop when done</p></div>` : ''}
        <input type="file" id="ai-photo-capture" accept="image/*" capture="environment" style="display:none">
        <input type="file" id="ai-photo-gallery" accept="image/*" style="display:none">
        <div class="ai-disclaimer"><p>AI estimates are not exact. Review before confirming.</p></div>
      </div>
    `;

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
    aiAttachedPhoto = await fileToDataUrl(file);
    renderModeContent();
  }

  async function startVoiceTranscription() {
    try {
      const vp = await loadVoiceParser();
      recorder = await vp.startRecording();
      isRecording = true;
      renderModeContent();
    } catch { showToast('Could not access microphone'); isRecording = false; }
  }

  async function stopVoiceTranscription() {
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
      } else {
        showToast(transcription.error || 'Could not transcribe');
      }
    } catch { showToast('Voice transcription failed'); }
    renderModeContent();
  }

  async function processAIInput() {
    const text = document.getElementById('ai-text-input')?.value.trim() || '';
    if (!text && !aiAttachedPhoto) { showToast('Add a photo or describe your meal'); return; }
    const ai = await loadAI();
    if (!ai || !(await ai.isAIConfigured())) { showToast('Set up an AI provider in Settings first'); return; }
    aiProcessing = true;
    aiResults = null;
    renderModeContent();
    try {
      if (aiAttachedPhoto) {
        // Photo mode (with optional text context)
        const proc = await loadImageProcessor();
        const result = await proc.analyzeImage(aiAttachedPhoto);
        aiResults = result.success ? result : { foods: [], error: result.error };
      } else {
        // Text-only mode
        const vp = await loadVoiceParser();
        const parsed = await vp.parseTranscription(text);
        aiResults = parsed.success ? parsed : { foods: [], error: parsed.error };
      }
      if (aiResults?.foods?.length) await checkClarification();
    } catch { aiResults = { foods: [], error: 'AI analysis failed' }; }
    aiProcessing = false;
    aiTextValue = '';
    aiAttachedPhoto = null;
    renderModeContent();
  }

  function stopVoice() {
    if (amplitudeInterval) clearInterval(amplitudeInterval);
    amplitudeInterval = null;
    isRecording = false;
    if (recorder) { try { recorder.cancel(); } catch {} recorder = null; }
  }

  // ===== CLARIFICATION =====
  async function checkClarification() {
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
      clarificationData = await engine.generateClarifications(aiResults.foods);
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
                  <button class="clarify-option ${oi === 0 ? 'selected' : ''}" data-question="${qi}" data-option="${oi}">${escapeHTML(opt.label)}</button>
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
        document.querySelectorAll(`.clarify-option[data-question="${qi}"]`).forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
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
            const conf = food._aiMeta?.confidence || food.source?.confidence || 0;
            const pct = Math.round(conf * 100);
            const cls = pct >= 75 ? 'high' : pct >= 50 ? 'medium' : 'low';
            const kcal = food.nutrients?.energy?.kcal || 0;
            const p = food.nutrients?.macros?.protein?.g || 0;
            const c = food.nutrients?.macros?.carbs?.g || 0;
            const f = food.nutrients?.macros?.fat?.g || 0;
            const qty = food.servingSize?.quantity || 100;
            const unit = food.servingSize?.unit || 'g';
            return `<div class="ai-food-item"><label class="ai-food-row">
              <input type="checkbox" class="ai-food-check" data-index="${i}" checked>
              <div class="ai-food-info"><div class="ai-food-name">${escapeHTML(food.name)}</div><div class="ai-food-portion">${qty} ${unit}</div></div>
              <div class="ai-food-nutrition"><span class="ai-food-kcal">${Math.round(kcal)} kcal</span><span class="ai-food-macros">${Math.round(p)}P ${Math.round(c)}C ${Math.round(f)}F</span></div>
              <span class="ai-confidence ai-confidence-${cls}">${pct}%</span>
            </label></div>`;
          }).join('')}
        </div>
        <div class="ai-results-actions">
          <button class="btn btn-secondary" id="ai-retry-btn">Retry</button>
          <button class="btn btn-primary" id="ai-confirm-btn">Log Selected (${foods.length})</button>
        </div>
      </div>
    `;
  }

  function wireAIResultEvents() {
    document.getElementById('ai-retry-btn')?.addEventListener('click', () => { aiResults = null; renderModeContent(); });
    document.querySelectorAll('.ai-food-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const n = document.querySelectorAll('.ai-food-check:checked').length;
        const btn = document.getElementById('ai-confirm-btn');
        if (btn) btn.textContent = `Log Selected (${n})`;
      });
    });
    document.getElementById('ai-confirm-btn')?.addEventListener('click', confirmAIFoods);
  }

  async function confirmAIFoods() {
    if (!aiResults?.foods) return;
    const checked = Array.from(document.querySelectorAll('.ai-food-check:checked')).map(cb => parseInt(cb.dataset.index));
    if (checked.length === 0) { showToast('Select at least one food'); return; }
    let logged = 0;
    for (const idx of checked) {
      const food = aiResults.foods[idx];
      if (!food) continue;
      if (!food.id) food.id = `ai-${Date.now()}-${idx}`;
      await put('foods', food);
      const qty = food.servingSize?.quantity || 100;
      const unit = food.servingSize?.unit || 'g';
      const mult = getNutritionMultiplier(qty, unit, food);
      await put('meals', {
        id: generateId(), date: todayStr(), type: mealType.toLowerCase(),
        items: [{ foodId: food.id, quantity: qty, unit, notes: `AI estimate`, nutrients: {
          kcal: (food.nutrients?.energy?.kcal || 0) * mult,
          protein: (food.nutrients?.macros?.protein?.g || 0) * mult,
          carbs: (food.nutrients?.macros?.carbs?.g || 0) * mult,
          fat: (food.nutrients?.macros?.fat?.g || 0) * mult,
          fiber: (food.nutrients?.fiber?.g || 0) * mult,
          sodium: (food.nutrients?.sodium?.mg || 0) * mult,
        }}],
        createdAt: new Date().toISOString(),
      });
      logged++;
    }
    showToast(`Logged ${logged} food${logged !== 1 ? 's' : ''}`);
    setTimeout(() => { window.location.hash = '#/diary'; }, 500);
  }

  // ===== SHARED HELPERS =====
  function bindFoodResultEvents(foods) {
    document.querySelectorAll('.food-result-item').forEach(el => {
      const handler = async () => {
        const foodId = el.dataset.foodId;
        const food = foods.find(f => f.id === foodId) || await getById('foods', foodId);
        if (food) openPortionModal(food, mealType);
      };
      el.addEventListener('click', handler);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
    });
  }

  render();
  // Cleanup on navigate away
  return () => { stopScanner(); stopVoice(); };
}

// ===== STANDALONE FUNCTIONS =====
function renderFoodResult(food) {
  const protein = food.nutrients?.macros?.protein?.g || 0;
  const carbs = food.nutrients?.macros?.carbs?.g || 0;
  const fat = food.nutrients?.macros?.fat?.g || 0;
  const kcal = food.nutrients?.energy?.kcal || 0;
  const macroSummary = `${Math.round(protein)}P ${Math.round(carbs)}C ${Math.round(fat)}F`;
  const servingLabel = food.servingSize ? `${food.servingSize.quantity} ${food.servingSize.unit}` : '100g';
  const sourceType = food.source?.type || '';
  const sourceClass = sourceType === 'openFoodFacts' ? 'off' : sourceType;
  const sourceLabel = sourceType === 'openFoodFacts' ? 'OFF' : sourceType.toUpperCase();
  const sourceBadge = sourceType ? `<span class="source-badge ${sourceClass}">${sourceLabel}</span>` : '';
  return `
    <div class="food-result-item" data-food-id="${food.id}" role="button" tabindex="0" aria-label="${escapeHTML(food.name)}, ${Math.round(kcal)} calories per ${servingLabel}">
      <div class="food-result-info">
        <div class="food-result-name">${escapeHTML(food.name)}</div>
        ${food.brand ? `<div class="food-result-brand">${escapeHTML(food.brand)}</div>` : ''}
        <div class="food-result-meta"><span class="kcal-badge">${Math.round(kcal)} kcal/${servingLabel}</span><span class="macro-summary">${macroSummary}</span>${sourceBadge}</div>
      </div>
      <div class="food-result-action" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div>
    </div>
  `;
}

function openPortionModal(food, mealType) {
  const baseNutrition = { calories: food.nutrients?.energy?.kcal || 0, protein: food.nutrients?.macros?.protein?.g || 0, carbs: food.nutrients?.macros?.carbs?.g || 0, fat: food.nutrients?.macros?.fat?.g || 0 };
  let quantity = 100, unit = food.servingSize?.unit || 'g', selectedMealType = mealType;
  const availableUnits = getUnitsForFood(food);

  function updatePreview() {
    const m = getNutritionMultiplier(quantity, unit, food);
    const preview = document.getElementById('nutrition-preview');
    if (preview) preview.innerHTML = `<div class="nutrition-preview"><div class="preview-stat"><span class="preview-label">Calories</span><span class="preview-value">${Math.round(baseNutrition.calories * m)} kcal</span></div><div class="preview-stat"><span class="preview-label">Protein</span><span class="preview-value">${(baseNutrition.protein * m).toFixed(1)}g</span></div><div class="preview-stat"><span class="preview-label">Carbs</span><span class="preview-value">${(baseNutrition.carbs * m).toFixed(1)}g</span></div><div class="preview-stat"><span class="preview-label">Fat</span><span class="preview-value">${(baseNutrition.fat * m).toFixed(1)}g</span></div></div>`;
  }

  const modal = document.createElement('div');
  modal.className = 'modal-content portion-editor';
  modal.innerHTML = `
    <div class="modal-header"><div><h2>${escapeHTML(food.name)}</h2>${food.brand ? `<p class="modal-subtitle">${escapeHTML(food.brand)}</p>` : ''}</div><button class="modal-close" id="modal-close" aria-label="Close">✕</button></div>
    <div class="portion-controls">
      <label class="control-group"><span class="control-label">Quantity</span><div class="quantity-input-group"><button class="qty-btn qty-minus" id="qty-minus" aria-label="Decrease">−</button><input type="number" class="qty-input" id="qty-input" value="${quantity}" min="0.1" step="0.1" aria-label="Quantity"><button class="qty-btn qty-plus" id="qty-plus" aria-label="Increase">+</button></div></label>
      <label class="control-group"><span class="control-label">Unit</span><select class="unit-select" id="unit-select" aria-label="Unit">${availableUnits.map(u => `<option value="${u.value}" ${u.value === unit ? 'selected' : ''}>${u.label}</option>`).join('')}</select></label>
      <label class="control-group"><span class="control-label">Meal</span><select class="meal-type-select" id="meal-type-select" aria-label="Meal type"><option value="breakfast" ${selectedMealType === 'Breakfast' ? 'selected' : ''}>Breakfast</option><option value="lunch" ${selectedMealType === 'Lunch' ? 'selected' : ''}>Lunch</option><option value="dinner" ${selectedMealType === 'Dinner' ? 'selected' : ''}>Dinner</option><option value="snacks" ${selectedMealType === 'Snacks' ? 'selected' : ''}>Snacks</option></select></label>
    </div>
    <div id="nutrition-preview"></div>
    <label class="control-group"><span class="control-label">Notes (optional)</span><input type="text" class="notes-input" id="notes-input" placeholder="e.g., with milk"></label>
    <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button><button class="btn btn-primary" id="log-btn">Log Food</button></div>
  `;
  openModal(modal);
  const qtyInput = document.getElementById('qty-input');
  document.getElementById('qty-minus').addEventListener('click', () => { qtyInput.value = Math.max(0.1, parseFloat(qtyInput.value) - 0.5); quantity = parseFloat(qtyInput.value); updatePreview(); });
  document.getElementById('qty-plus').addEventListener('click', () => { qtyInput.value = (parseFloat(qtyInput.value) + 0.5).toFixed(1); quantity = parseFloat(qtyInput.value); updatePreview(); });
  qtyInput.addEventListener('change', () => { quantity = parseFloat(qtyInput.value) || 100; updatePreview(); });
  document.getElementById('unit-select')?.addEventListener('change', (e) => { unit = e.target.value; updatePreview(); });
  document.getElementById('meal-type-select').addEventListener('change', (e) => { selectedMealType = e.target.value; });
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('log-btn').addEventListener('click', () => logFood(food, quantity, unit, selectedMealType, document.getElementById('notes-input').value));
  updatePreview();
}

async function logFood(food, quantity, unit, mealType, notes) {
  try {
    if (!food.id) food.id = generateId();
    const existing = await getById('foods', food.id);
    if (!existing) await put('foods', food);
    const mult = getNutritionMultiplier(quantity, unit, food);
    await put('meals', {
      id: generateId(), date: todayStr(), type: mealType.toLowerCase(),
      items: [{ foodId: food.id, quantity, unit, notes, nutrients: {
        kcal: (food.nutrients?.energy?.kcal || 0) * mult,
        protein: (food.nutrients?.macros?.protein?.g || 0) * mult,
        carbs: (food.nutrients?.macros?.carbs?.g || 0) * mult,
        fat: (food.nutrients?.macros?.fat?.g || 0) * mult,
        fiber: (food.nutrients?.fiber?.g || 0) * mult,
        sodium: (food.nutrients?.sodium?.mg || 0) * mult,
      }}],
      createdAt: new Date().toISOString(),
    });
    showToast(`${food.name} logged to ${mealType}`);
    closeModal();
    setTimeout(() => { window.location.hash = '#/diary'; }, 500);
  } catch (err) { console.error('Log error:', err); showToast('Failed to log food'); }
}

function openCustomFoodForm() {
  const modal = document.createElement('div');
  modal.className = 'modal-content custom-food-form';
  modal.innerHTML = `
    <div class="modal-header"><h2>Add Custom Food</h2><button class="modal-close" id="modal-close">✕</button></div>
    <div class="form-group"><label><span class="control-label">Food Name</span><input type="text" id="custom-name" placeholder="e.g., Homemade pasta" class="form-input"></label></div>
    <div class="form-row"><label class="form-group"><span class="control-label">Calories per 100g</span><input type="number" id="custom-kcal" placeholder="0" class="form-input" min="0"></label><label class="form-group"><span class="control-label">Protein (g)</span><input type="number" id="custom-protein" placeholder="0" class="form-input" min="0" step="0.1"></label></div>
    <div class="form-row"><label class="form-group"><span class="control-label">Carbs (g)</span><input type="number" id="custom-carbs" placeholder="0" class="form-input" min="0" step="0.1"></label><label class="form-group"><span class="control-label">Fat (g)</span><input type="number" id="custom-fat" placeholder="0" class="form-input" min="0" step="0.1"></label></div>
    <div class="modal-actions"><button class="btn btn-secondary" id="cancel-btn">Cancel</button><button class="btn btn-primary" id="save-btn">Add Food</button></div>
  `;
  openModal(modal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('save-btn').addEventListener('click', () => {
    const name = document.getElementById('custom-name').value.trim();
    const kcal = parseFloat(document.getElementById('custom-kcal').value) || 0;
    const protein = parseFloat(document.getElementById('custom-protein').value) || 0;
    const carbs = parseFloat(document.getElementById('custom-carbs').value) || 0;
    const fat = parseFloat(document.getElementById('custom-fat').value) || 0;
    if (!name || kcal <= 0) { showToast('Please fill in food name and calories'); return; }
    const customFood = { id: generateId(), name, nutrients: { energy: { kcal }, macros: { protein: { g: protein }, carbs: { g: carbs }, fat: { g: fat } }, fiber: { g: 0 }, sodium: { mg: 0 } }, servingSize: { quantity: 100, unit: 'g', aliases: [] }, source: { type: 'custom' }, createdAt: new Date().toISOString() };
    closeModal();
    setTimeout(() => openPortionModal(customFood, 'Lunch'), 200);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
