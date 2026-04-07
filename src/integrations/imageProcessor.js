import { chatCompletion, logUsage, isAIConfigured, getAIConfig } from './aiClient.js';

const FOOD_ANALYSIS_PROMPT = `You are a nutrition analysis assistant. Analyze the food photo and identify each distinct food item visible.
For each food item, provide:
- name: common food name
- portion_grams: estimated weight in grams
- confidence: your confidence in the identification (0.0-1.0)
- calories: estimated kcal for the portion
- protein: grams of protein
- carbs: grams of carbohydrates
- fat: grams of fat

Return a JSON object with a "foods" array. Be specific about portion sizes.
If you cannot identify a food, include it with a low confidence score and your best guess.
Estimate portions conservatively — it's better to underestimate than overestimate.

Critical: estimate the ACTUAL portion visible, not per-100g defaults. If you see a whole plate of pasta, estimate the full plate weight (~300g), not 100g. If you see a tin of sardines, use the real tin weight (~125g). Calculate calories and macros for the total visible portion.`;

/**
 * Analyze a food photo and return identified foods with nutrition estimates.
 * @param {string} imageDataUrl - Base64 data URL from camera capture or file picker
 * @returns {Promise<{success: boolean, foods?: Array, processingTime?: number, error?: string}>}
 */
export async function analyzeImage(imageDataUrl) {
  if (!isAIConfigured()) {
    return { success: false, error: 'AI not configured' };
  }

  const startTime = Date.now();

  try {
    const compressedDataUrl = await compressImage(imageDataUrl);

    const messages = [
      { role: 'system', content: FOOD_ANALYSIS_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Identify all foods in this photo. For each food, estimate the portion size in grams and provide nutrition information.',
          },
          {
            type: 'image_url',
            image_url: { url: compressedDataUrl },
          },
        ],
      },
    ];

    const response = await chatCompletion(messages, {
      maxTokens: 1024,
      temperature: 0.2,
      jsonMode: true,
    });

    if (!response.content) {
      return { success: false, error: response.error || 'AI returned no content' };
    }

    // Strip markdown code fences if present
    let rawContent = response.content;
    if (typeof rawContent === 'string') {
      rawContent = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    }

    const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;

    if (!parsed.foods || !Array.isArray(parsed.foods)) {
      return { success: false, error: 'Unexpected response format from AI' };
    }

    const normalizedFoods = normalizeAnalysisResult(parsed.foods);
    const processingTime = Date.now() - startTime;

    const config = await getAIConfig();
    const estimatedCost = config.provider === 'anthropic' ? 0.005 : 0.01;
    logUsage({
      feature: 'image-analysis',
      cost: estimatedCost,
      provider: config.provider,
    });

    return { success: true, foods: normalizedFoods, processingTime };
  } catch (err) {
    return { success: false, error: err.message || 'Image analysis failed' };
  }
}

/**
 * Compress an image data URL by resizing to max 1024px width and converting to JPEG.
 * @param {string} dataUrl - Original base64 data URL
 * @returns {Promise<string>} Compressed base64 data URL
 */
export async function compressImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      let { width, height } = img;

      if (width > 1024) {
        const scale = 1024 / width;
        width = 1024;
        height = Math.round(height * scale);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.8);
      resolve(compressedDataUrl);
    };

    img.onerror = () => reject(new Error('Failed to load image for compression'));
    img.src = dataUrl;
  });
}

/**
 * Normalize AI response foods into LibreLog food schema objects.
 * @param {Array} foods - Raw foods array from AI response
 * @returns {Array} Normalized food objects
 */
export function normalizeAnalysisResult(foods) {
  return foods.map((food, index) => ({
    id: `ai-${Date.now()}-${index}`,
    name: food.name,
    servingSize: {
      quantity: food.portion_grams,
      unit: 'g',
    },
    nutrients: {
      energy: { kcal: food.calories },
      macros: {
        protein: { g: food.protein },
        carbs: { g: food.carbs },
        fat: { g: food.fat },
      },
      fiber: { g: 0 },
      sodium: { mg: 0 },
    },
    source: {
      type: 'ai-photo',
      confidence: food.confidence,
    },
    _aiMeta: {
      confidence: food.confidence,
      portionGrams: food.portion_grams,
    },
  }));
}
