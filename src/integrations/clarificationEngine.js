/**
 * AI Clarification Engine for LibreLog
 * Generates targeted follow-up questions for low-confidence food detections
 * and applies pre-computed refinements based on user answers.
 */

import { chatCompletion, getAIConfig, logUsage } from './aiClient.js';
import { validateAIResponse } from './aiValidation.js';

const CONFIDENCE_THRESHOLD = 0.85;

const CLARIFICATION_PROMPT = `You are a nutrition assistant. Given these detected foods with confidence scores, generate targeted clarifying questions ONLY for items with confidence below ${CONFIDENCE_THRESHOLD}.

For each low-confidence food, generate ONE question with 2-4 answer options. Each option must include the full refined nutrition data so the app can update instantly without another API call.

Return JSON:
{
  "questions": [
    {
      "foodIndex": 0,
      "question": "How were the eggs prepared?",
      "options": [
        {
          "label": "Scrambled",
          "refinedFood": { "name": "Scrambled eggs", "portion_grams": 120, "calories": 182, "protein": 12, "carbs": 1, "fat": 14, "confidence": 0.95 }
        },
        {
          "label": "Fried",
          "refinedFood": { "name": "Fried eggs", "portion_grams": 100, "calories": 196, "protein": 14, "carbs": 1, "fat": 15, "confidence": 0.95 }
        }
      ]
    }
  ]
}

Rules:
- Only ask about foods where clarification meaningfully changes nutrition (>15% calorie difference between options)
- Maximum 3 questions total
- Keep option labels short (1-3 words) for mobile tap targets
- Each option's refinedFood must include: name, portion_grams, calories, protein, carbs, fat, confidence
- If no questions are needed, return {"questions": []}`;

/**
 * Check if any detected foods need clarification.
 * @param {Array} foods - Normalized food objects from AI detection
 * @param {number} [threshold] - Confidence threshold (default 0.85)
 * @returns {boolean}
 */
export function needsClarification(foods, threshold = CONFIDENCE_THRESHOLD) {
  if (!Array.isArray(foods) || foods.length === 0) return false;
  return foods.some(f => {
    const conf = f._aiMeta?.confidence ?? f.source?.confidence ?? 1;
    return conf < threshold;
  });
}

/**
 * Generate clarifying questions for low-confidence foods.
 * Makes one AI call that returns questions with pre-computed answers.
 * @param {Array} foods - Normalized food objects
 * @param {Array} originalMessages - Original message thread (for context, e.g. photo)
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{questions: Array}>}
 */
export async function generateClarifications(foods, originalMessages = [], options = {}) {
  try {
    const foodSummary = foods.map((f, i) => ({
      index: i,
      name: f.name,
      portion: `${f.servingSize?.quantity ?? 100}${f.servingSize?.unit ?? 'g'}`,
      calories: f.nutrients?.energy?.kcal ?? 0,
      protein: f.nutrients?.macros?.protein?.g ?? 0,
      carbs: f.nutrients?.macros?.carbs?.g ?? 0,
      fat: f.nutrients?.macros?.fat?.g ?? 0,
      confidence: f._aiMeta?.confidence ?? f.source?.confidence ?? 1,
    }));

    // Build message thread with original context
    const messages = [
      ...originalMessages,
      {
        role: 'assistant',
        content: JSON.stringify({ foods: foodSummary }),
      },
      {
        role: 'user',
        content: `${CLARIFICATION_PROMPT}\n\nDetected foods:\n${JSON.stringify(foodSummary, null, 2)}`,
      },
    ];

    const response = await chatCompletion(messages, {
      maxTokens: 1024,
      temperature: 0.2,
      jsonMode: true,
      signal: options.signal,
      mutationGeneration: options.mutationGeneration,
    });

    if (!response.content) {
      return { questions: [] };
    }

    let rawContent = response.content;
    if (typeof rawContent === 'string') {
      rawContent = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    }

    const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;

    if (response.usage) {
      const config = await getAIConfig();
      const tokens = response.usage.totalTokens || 0;
      const cost = config.provider === 'anthropic' ? tokens * 0.000003 : tokens * 0.000005;
      await logUsage(config.provider, tokens, cost, {
        mutationGeneration: response.mutationGeneration,
      });
    }

    return { questions: normalizeQuestions(parsed.questions, foods.length) };
  } catch (err) {
    console.warn('Clarification generation failed:', err);
    return { questions: [] };
  }
}

/**
 * Apply a user's selected refinement to a food item.
 * Pure function — returns a new foods array with the specified food updated.
 * @param {Array} foods - Current foods array
 * @param {number} foodIndex - Index of the food to refine
 * @param {Object} selectedOption - The selected option with refinedFood data
 * @returns {Array} Updated foods array
 */
export function applyRefinement(foods, foodIndex, selectedOption) {
  if (!selectedOption?.refinedFood) return foods;

  const refined = selectedOption.refinedFood;
  let normalized;
  try {
    normalized = validateAIResponse(
      { foods: [refined] },
      { sourceType: foods[foodIndex]?.source?.type || 'ai-text', idPrefix: 'ai-refined' },
    ).foods[0];
  } catch {
    return foods;
  }

  return foods.map((food, i) => {
    if (i !== foodIndex) return food;
    return {
      ...food,
      name: normalized.name,
      servingSize: normalized.servingSize,
      nutrients: {
        ...normalized.nutrients,
        fiber: food.nutrients?.fiber ?? { g: null },
        sodium: food.nutrients?.sodium ?? { mg: null },
      },
      source: {
        ...food.source,
        confidence: normalized.source.confidence,
      },
      _aiMeta: {
        ...food._aiMeta,
        confidence: normalized._aiMeta.confidence,
        assumptions: [
          ...(food._aiMeta?.assumptions || []),
          ...normalized._aiMeta.assumptions,
        ].slice(0, 6),
        warnings: normalized._aiMeta.warnings,
        refined: true,
      },
    };
  });
}

function normalizeQuestions(value, foodCount) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap(question => {
    const foodIndex = Number(question?.foodIndex);
    const text = typeof question?.question === 'string'
      ? question.question.replace(/\s+/g, ' ').trim().slice(0, 240)
      : '';
    if (!Number.isInteger(foodIndex) || foodIndex < 0 || foodIndex >= foodCount || !text) return [];

    const options = Array.isArray(question.options)
      ? question.options.slice(0, 4).flatMap(option => {
        const label = typeof option?.label === 'string'
          ? option.label.replace(/\s+/g, ' ').trim().slice(0, 80)
          : '';
        if (!label || !option?.refinedFood) return [];
        try {
          validateAIResponse({ foods: [option.refinedFood] });
          return [{ label, refinedFood: option.refinedFood }];
        } catch {
          return [];
        }
      })
      : [];

    return options.length >= 2 ? [{ foodIndex, question: text, options }] : [];
  });
}
