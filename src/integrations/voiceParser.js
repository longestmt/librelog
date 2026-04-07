/**
 * Voice-based meal logging for LibreLog
 * Handles audio capture, transcription, and structured food data extraction
 */

import { chatCompletion, logUsage, isAIConfigured, getAIConfig } from './aiClient.js';

const VOICE_PARSE_PROMPT = `You are a food logging assistant. Parse the user's spoken meal description into structured food items.
For each food mentioned, provide:
- name: the food name
- quantity: numeric amount
- unit: unit of measurement (g, ml, oz, cup, tbsp, tsp, piece, slice, tin, bowl, serving, etc.)
- calories: estimated kcal
- protein: grams
- carbs: grams
- fat: grams
- confidence: your confidence in the identification and portion estimate (0.0-1.0)

Handle natural language quantities:
- "a handful of almonds" → ~30g
- "two eggs" → 2 pieces
- "a glass of milk" → 240ml
- "some rice" → ~150g (one serving)
- "a bowl of miso soup" → 1 bowl (NOT 250 bowl)

Important: quantity and unit must be logically consistent. If using a container unit (bowl, tin, cup, glass), quantity should be the count of containers (e.g., 1 bowl, 2 cups). If using weight/volume units (g, ml, oz), quantity should be the amount in that unit (e.g., 250 g). Never combine a weight number with a container unit.

Critical: calculate calories and macros for the TOTAL portion described, not per 100g. When a user mentions a packaged container (tin, can, bottle, bar, bag, packet, box), use realistic product weights:
- a tin/can of sardines → ~125g total, ~310 kcal
- a can of tuna → ~160g drained, ~200 kcal
- a protein bar → ~60g, ~220 kcal
- a bag/packet of chips → ~28g (single serve), ~140 kcal
- a can of soda → ~355ml, ~140 kcal
- a bottle of beer → ~355ml, ~150 kcal
Do NOT default to 100g. Use the actual expected weight of the container or serving the user described.

Return a JSON object with a "foods" array. If uncertain about portions, use standard serving sizes.`;

/**
 * Start recording audio from the microphone.
 * For OpenAI: records audio via MediaRecorder for Whisper transcription.
 * For Anthropic/Ollama: runs browser SpeechRecognition live alongside
 * MediaRecorder so we capture a transcript during recording.
 *
 * @returns {Promise<{ stop: () => Promise<{blob: Blob, liveTranscript: string|null}>, cancel: () => void, getAmplitude: () => number }>}
 */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  // Amplitude analysis
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  // MediaRecorder
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];

  recorder.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });
  recorder.start();

  // Start live browser speech recognition in parallel (for non-OpenAI providers)
  let liveTranscript = null;
  let recognition = null;
  try {
    const config = await getAIConfig();
    if (config.provider !== 'openai') {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.lang = navigator.language || 'en-US';
        recognition.continuous = true;
        recognition.interimResults = false;
        let segments = [];
        recognition.addEventListener('result', (event) => {
          for (let i = 0; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              segments.push(event.results[i][0].transcript);
            }
          }
          liveTranscript = segments.join(' ').trim();
        });
        recognition.addEventListener('error', () => { /* non-fatal */ });
        recognition.start();
      }
    }
  } catch { /* config fetch failed — skip live recognition */ }

  return {
    stop() {
      return new Promise((resolve) => {
        // Stop speech recognition
        if (recognition) { try { recognition.stop(); } catch {} }

        recorder.addEventListener('stop', () => {
          stream.getTracks().forEach(t => t.stop());
          audioContext.close().catch(() => {});
          resolve({
            blob: new Blob(chunks, { type: mimeType }),
            liveTranscript,
          });
        });
        recorder.stop();
      });
    },

    cancel() {
      if (recognition) { try { recognition.stop(); } catch {} }
      recorder.stop();
      stream.getTracks().forEach(t => t.stop());
      audioContext.close().catch(() => {});
      chunks.length = 0;
    },

    getAmplitude() {
      analyser.getByteTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sum += normalized * normalized;
      }
      return Math.sqrt(sum / dataArray.length);
    },
  };
}

/**
 * Transcribe audio to text.
 * - OpenAI: sends blob to Whisper API
 * - Anthropic/Ollama: uses the liveTranscript captured during recording,
 *   or falls back to browser SpeechRecognition
 *
 * @param {Blob} audioBlob - Recorded audio blob
 * @param {string|null} liveTranscript - Transcript captured during recording (for non-OpenAI)
 * @returns {Promise<{ text: string|null, method?: string, error?: string }>}
 */
export async function transcribeAudio(audioBlob, liveTranscript = null) {
  try {
    const config = await getAIConfig();

    // OpenAI: use Whisper API
    if (config.provider === 'openai' && config.apiKey) {
      const formData = new FormData();
      formData.append('file', audioBlob, 'recording.webm');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'text');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}` },
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Whisper API error: ${response.status}`);
        }

        const text = await response.text();
        return { text: text.trim(), method: 'whisper' };
      } finally {
        clearTimeout(timeout);
      }
    }

    // Anthropic/Ollama: use the live transcript captured during recording
    if (liveTranscript) {
      return { text: liveTranscript, method: 'browser' };
    }

    // No live transcript available — try one-shot browser recognition
    // (this is a fallback; it won't process the blob, it requires live mic)
    return { text: null, error: 'Voice transcription requires OpenAI (Whisper) or a browser with Speech Recognition support. Your browser did not capture a transcript during recording.' };
  } catch (err) {
    return { text: null, error: err.message || 'Transcription failed' };
  }
}

/**
 * Parse transcribed text into structured food data using the LLM.
 * @param {string} text - Transcribed meal description
 * @returns {Promise<{ success: boolean, foods?: Array, error?: string }>}
 */
export async function parseTranscription(text) {
  try {
    if (!text || !text.trim()) {
      return { success: false, error: 'No text to parse' };
    }

    const messages = [
      { role: 'system', content: VOICE_PARSE_PROMPT },
      { role: 'user', content: text },
    ];

    const response = await chatCompletion(messages, {
      maxTokens: 512,
      temperature: 0.2,
      jsonMode: true,
    });

    if (!response.content) {
      return { success: false, error: response.error || 'AI returned no content' };
    }

    // Strip markdown code fences if present (e.g. ```json ... ```)
    let rawContent = response.content;
    if (typeof rawContent === 'string') {
      rawContent = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    }

    const parsed = typeof rawContent === 'string'
      ? JSON.parse(rawContent)
      : rawContent;

    if (response.usage) {
      const config = await getAIConfig();
      const tokens = response.usage.totalTokens || 0;
      const cost = config.provider === 'anthropic' ? tokens * 0.000003 : tokens * 0.000005;
      await logUsage(config.provider, tokens, cost);
    }

    const normalizedFoods = normalizeParsedFoods(parsed.foods || []);
    return { success: true, foods: normalizedFoods };
  } catch (err) {
    return { success: false, error: err.message || 'Failed to parse transcription' };
  }
}

/**
 * Normalize parsed food items to the LibreLog food schema.
 * @param {Array} foods - Raw food items from LLM response
 * @returns {Array} Normalized food entries
 */
export function normalizeParsedFoods(foods) {
  return foods.map((food, index) => ({
    id: `ai-voice-${Date.now()}-${index}`,
    name: food.name || 'Unknown food',
    servingSize: {
      quantity: food.quantity || 100,
      unit: food.unit || 'g',
    },
    nutrients: {
      energy: { kcal: food.calories || 0 },
      macros: {
        protein: { g: food.protein || 0 },
        carbs: { g: food.carbs || 0 },
        fat: { g: food.fat || 0 },
      },
      fiber: { g: 0 },
      sodium: { mg: 0 },
    },
    source: { type: 'ai-voice', confidence: food.confidence ?? 0.7 },
    _aiMeta: { confidence: food.confidence ?? 0.7 },
  }));
}
