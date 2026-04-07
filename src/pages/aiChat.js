/**
 * aiChat.js — AI-assisted food logging page
 * Photo analysis + voice logging with BYOK API keys
 */

import { getById, put } from '../data/db.js';
import { todayStr } from '../utils/format.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { getUnitsForFood, getNutritionMultiplier } from '../utils/units.js';

let aiClientMod = null;
let imageProcessorMod = null;
let voiceParserMod = null;

async function loadAIModules() {
  if (!aiClientMod) aiClientMod = await import('../integrations/aiClient.js');
  return aiClientMod;
}
async function loadImageProcessor() {
  if (!imageProcessorMod) imageProcessorMod = await import('../integrations/imageProcessor.js');
  return imageProcessorMod;
}
async function loadVoiceParser() {
  if (!voiceParserMod) voiceParserMod = await import('../integrations/voiceParser.js');
  return voiceParserMod;
}

export function renderAIChatPage(container, queryString) {
  const params = new URLSearchParams(queryString);
  const mealType = params.get('meal') || getMealTypeForTime();

  let currentMode = 'photo'; // 'photo' | 'voice'
  let analysisResults = null;
  let isProcessing = false;
  let recorder = null;
  let isRecording = false;
  let amplitudeInterval = null;

  async function render() {
    const ai = await loadAIModules();
    const configured = await ai.isAIConfigured();

    container.innerHTML = `
      <div class="ai-page" role="main" aria-label="AI Food Logging">
        <div class="ai-header">
          <h1>AI Food Log</h1>
          <p class="ai-subtitle">Photo or voice — we'll identify your food</p>
        </div>

        ${!configured ? renderSetupPrompt() : renderAIInterface()}
      </div>
    `;

    if (!configured) {
      document.getElementById('goto-settings-btn')?.addEventListener('click', () => {
        window.location.hash = '#/settings';
      });
      return;
    }

    // Tab switching
    document.querySelectorAll('.ai-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentMode = btn.dataset.mode;
        render();
      });
    });

    // Photo handlers
    document.getElementById('photo-capture-btn')?.addEventListener('click', handlePhotoCapture);
    document.getElementById('photo-gallery-btn')?.addEventListener('click', handleGalleryPick);

    // Voice handlers
    document.getElementById('voice-record-btn')?.addEventListener('click', handleVoiceToggle);

    // Result action handlers
    document.querySelectorAll('.ai-food-check').forEach(cb => {
      cb.addEventListener('change', () => updateConfirmButton());
    });
    document.getElementById('ai-confirm-btn')?.addEventListener('click', handleConfirmFoods);
    document.getElementById('ai-retry-btn')?.addEventListener('click', () => {
      analysisResults = null;
      render();
    });
  }

  function renderSetupPrompt() {
    return `
      <div class="ai-setup-prompt">
        <div class="ai-setup-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/><circle cx="12" cy="15" r="2"/></svg>
        </div>
        <h2>AI Features (Optional)</h2>
        <p>Bring your own API key to enable photo and voice food logging. Your key stays on your device — LibreLog never sees it.</p>
        <p class="ai-cost-note">Estimated cost: $0.01–0.03 per photo analysis</p>
        <button class="btn btn-primary" id="goto-settings-btn">Set Up API Key</button>
        <p class="ai-skip-note">Your app works perfectly without AI. <a href="#/scan">Search or scan instead</a></p>
      </div>
    `;
  }

  function renderAIInterface() {
    return `
      <!-- Mode Tabs -->
      <div class="ai-tabs" role="tablist" aria-label="AI logging mode">
        <button class="ai-tab-btn ${currentMode === 'photo' ? 'active' : ''}" data-mode="photo" role="tab" aria-selected="${currentMode === 'photo'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Photo
        </button>
        <button class="ai-tab-btn ${currentMode === 'voice' ? 'active' : ''}" data-mode="voice" role="tab" aria-selected="${currentMode === 'voice'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
          Voice
        </button>
      </div>

      <!-- Content Area -->
      <div class="ai-content" role="tabpanel">
        ${isProcessing ? renderProcessing() : ''}
        ${analysisResults ? renderResults() : ''}
        ${!isProcessing && !analysisResults ? (currentMode === 'photo' ? renderPhotoInput() : renderVoiceInput()) : ''}
      </div>

      <!-- Disclaimer -->
      <div class="ai-disclaimer">
        <p>AI estimates are not exact. Always review portions and nutrition before confirming.</p>
      </div>
    `;
  }

  function renderPhotoInput() {
    return `
      <div class="ai-photo-input">
        <div class="ai-photo-area" id="photo-drop-area">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <p>Take a photo of your meal</p>
          <p class="text-muted">or choose from gallery</p>
        </div>
        <div class="ai-photo-buttons">
          <button class="btn btn-primary" id="photo-capture-btn" aria-label="Take photo with camera">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            Take Photo
          </button>
          <button class="btn btn-secondary" id="photo-gallery-btn" aria-label="Choose from photo gallery">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            Gallery
          </button>
        </div>
        <input type="file" id="photo-file-input" accept="image/*" capture="environment" style="display:none">
        <input type="file" id="gallery-file-input" accept="image/*" style="display:none">
      </div>
    `;
  }

  function renderVoiceInput() {
    return `
      <div class="ai-voice-input">
        <div class="ai-voice-area">
          <button class="ai-voice-btn ${isRecording ? 'recording' : ''}" id="voice-record-btn" aria-label="${isRecording ? 'Stop recording' : 'Start recording'}">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="${isRecording ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              ${isRecording
                ? '<rect x="6" y="6" width="12" height="12" rx="2"/>'
                : '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>'}
            </svg>
          </button>
          <div class="ai-voice-waveform" id="voice-waveform">
            ${isRecording ? '<div class="waveform-bars">' + Array(12).fill('<div class="waveform-bar"></div>').join('') + '</div>' : ''}
          </div>
          <p class="ai-voice-hint">${isRecording ? 'Listening... tap to stop' : 'Tap to start recording'}</p>
          <p class="ai-voice-example">Speak naturally: "I had two eggs, toast with butter, and a coffee"</p>
        </div>
        <div id="voice-transcription" class="ai-transcription" style="display:none"></div>
      </div>
    `;
  }

  function renderProcessing() {
    return `
      <div class="ai-processing">
        <div class="ai-spinner"></div>
        <p>Analyzing your ${currentMode === 'photo' ? 'photo' : 'recording'}...</p>
        <p class="text-muted">This usually takes 1-3 seconds</p>
      </div>
    `;
  }

  function renderResults() {
    if (!analysisResults || !analysisResults.foods || analysisResults.foods.length === 0) {
      return `
        <div class="ai-no-results">
          <p>Could not identify any foods. ${analysisResults?.error ? escapeHTML(analysisResults.error) : ''}</p>
          <button class="btn btn-primary" id="ai-retry-btn">Try Again</button>
          <a href="#/scan" class="btn btn-secondary">Search Manually</a>
        </div>
      `;
    }

    const foods = analysisResults.foods;
    return `
      <div class="ai-results">
        <h3 class="ai-results-title">Detected Foods</h3>
        <p class="ai-results-time">${analysisResults.processingTime ? `Analyzed in ${(analysisResults.processingTime / 1000).toFixed(1)}s` : ''}</p>
        <div class="ai-food-list">
          ${foods.map((food, i) => {
            const confidence = food._aiMeta?.confidence || food.source?.confidence || 0;
            const confPercent = Math.round(confidence * 100);
            const confClass = confPercent >= 75 ? 'high' : confPercent >= 50 ? 'medium' : 'low';
            const kcal = food.nutrients?.energy?.kcal || 0;
            const protein = food.nutrients?.macros?.protein?.g || 0;
            const carbs = food.nutrients?.macros?.carbs?.g || 0;
            const fat = food.nutrients?.macros?.fat?.g || 0;
            const qty = food.servingSize?.quantity || 100;
            const unit = food.servingSize?.unit || 'g';
            return `
              <div class="ai-food-item">
                <label class="ai-food-row">
                  <input type="checkbox" class="ai-food-check" data-index="${i}" checked>
                  <div class="ai-food-info">
                    <div class="ai-food-name">${escapeHTML(food.name)}</div>
                    <div class="ai-food-portion">${qty}${unit}</div>
                  </div>
                  <div class="ai-food-nutrition">
                    <span class="ai-food-kcal">${Math.round(kcal)} kcal</span>
                    <span class="ai-food-macros">${Math.round(protein)}P ${Math.round(carbs)}C ${Math.round(fat)}F</span>
                  </div>
                  <span class="ai-confidence ai-confidence-${confClass}" title="Confidence: ${confPercent}%">
                    ${confPercent}%
                  </span>
                </label>
              </div>
            `;
          }).join('')}
        </div>
        <div class="ai-results-actions">
          <button class="btn btn-secondary" id="ai-retry-btn">Retry</button>
          <button class="btn btn-primary" id="ai-confirm-btn">
            Log Selected (${foods.length})
          </button>
        </div>
      </div>
    `;
  }

  function updateConfirmButton() {
    const checked = document.querySelectorAll('.ai-food-check:checked').length;
    const btn = document.getElementById('ai-confirm-btn');
    if (btn) btn.textContent = `Log Selected (${checked})`;
  }

  async function handlePhotoCapture() {
    const input = document.getElementById('photo-file-input');
    if (!input) return;
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (file) await processImage(file);
    };
    input.click();
  }

  async function handleGalleryPick() {
    const input = document.getElementById('gallery-file-input');
    if (!input) return;
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (file) await processImage(file);
    };
    input.click();
  }

  async function processImage(file) {
    isProcessing = true;
    analysisResults = null;
    render();

    try {
      const dataUrl = await fileToDataUrl(file);
      const processor = await loadImageProcessor();
      const result = await processor.analyzeImage(dataUrl);
      analysisResults = result.success ? result : { foods: [], error: result.error };
    } catch (err) {
      console.error('Photo analysis error:', err);
      analysisResults = { foods: [], error: 'Failed to analyze photo' };
      showToast('Photo analysis failed');
    } finally {
      isProcessing = false;
      render();
    }
  }

  async function handleVoiceToggle() {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecordingSession();
    }
  }

  async function startRecordingSession() {
    try {
      const vp = await loadVoiceParser();
      recorder = await vp.startRecording();
      isRecording = true;
      render();

      // Animate waveform bars
      amplitudeInterval = setInterval(() => {
        if (!recorder) return;
        const amp = recorder.getAmplitude();
        const bars = document.querySelectorAll('.waveform-bar');
        bars.forEach((bar, i) => {
          const h = Math.max(4, (amp * 100 * (0.5 + Math.random() * 0.5)));
          bar.style.height = `${h}%`;
        });
      }, 100);
    } catch (err) {
      console.error('Recording error:', err);
      showToast('Could not access microphone');
      isRecording = false;
    }
  }

  async function stopRecording() {
    if (amplitudeInterval) clearInterval(amplitudeInterval);
    amplitudeInterval = null;
    isRecording = false;

    if (!recorder) return;

    isProcessing = true;
    render();

    try {
      const vp = await loadVoiceParser();
      const audioBlob = await recorder.stop();
      recorder = null;

      // Show transcription step
      const transcription = await vp.transcribeAudio(audioBlob);
      if (!transcription.text) {
        analysisResults = { foods: [], error: transcription.error || 'Could not transcribe audio' };
        isProcessing = false;
        render();
        return;
      }

      // Parse transcription into foods
      const parsed = await vp.parseTranscription(transcription.text);
      analysisResults = parsed.success ? parsed : { foods: [], error: parsed.error };
    } catch (err) {
      console.error('Voice processing error:', err);
      analysisResults = { foods: [], error: 'Voice processing failed' };
      showToast('Voice processing failed');
    } finally {
      isProcessing = false;
      render();
    }
  }

  async function handleConfirmFoods() {
    if (!analysisResults?.foods) return;

    const checked = document.querySelectorAll('.ai-food-check:checked');
    const indices = Array.from(checked).map(cb => parseInt(cb.dataset.index));

    if (indices.length === 0) {
      showToast('Select at least one food to log');
      return;
    }

    let logged = 0;
    for (const idx of indices) {
      const food = analysisResults.foods[idx];
      if (!food) continue;

      // Ensure food has an id
      if (!food.id) food.id = `ai-${Date.now()}-${idx}`;

      // Save food to DB
      await put('foods', food);

      const qty = food.servingSize?.quantity || 100;
      const unit = food.servingSize?.unit || 'g';
      const multiplier = getNutritionMultiplier(qty, unit, food);

      await put('meals', {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: todayStr(),
        type: mealType,
        items: [{
          foodId: food.id,
          quantity: qty,
          unit,
          notes: `AI ${currentMode} estimate`,
          nutrients: {
            kcal: (food.nutrients?.energy?.kcal || 0) * multiplier,
            protein: (food.nutrients?.macros?.protein?.g || 0) * multiplier,
            carbs: (food.nutrients?.macros?.carbs?.g || 0) * multiplier,
            fat: (food.nutrients?.macros?.fat?.g || 0) * multiplier,
            fiber: (food.nutrients?.fiber?.g || 0) * multiplier,
            sodium: (food.nutrients?.sodium?.mg || 0) * multiplier,
          },
        }],
        createdAt: new Date().toISOString(),
      });
      logged++;
    }

    showToast(`Logged ${logged} food${logged !== 1 ? 's' : ''}`);
    setTimeout(() => { window.location.hash = '#/diary'; }, 500);
  }

  render();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getMealTypeForTime() {
  const hour = new Date().getHours();
  if (hour < 12) return 'breakfast';
  if (hour < 17) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snacks';
}
