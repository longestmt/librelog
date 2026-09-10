import { newId } from '../data/identity.js';

/**
 * Deterministic validation for untrusted AI nutrition output.
 * This module deliberately has no browser or provider dependencies so the same
 * fixtures can run locally without credentials or paid API calls.
 */

const LIMITS = Object.freeze({
  maxItems: 20,
  nameLength: 120,
  unitLength: 24,
  assumptionLength: 240,
  quantity: [0.01, 10_000],
  calories: [0, 10_000],
  macroGrams: [0, 2_000],
  confidence: [0, 1],
});
export const AI_RESULT_SCHEMA_VERSION = 1;

function finiteInRange(value, [minimum, maximum]) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeAssumptions(value) {
  const values = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const assumptions = values
    .map(item => cleanText(item, LIMITS.assumptionLength))
    .filter(Boolean)
    .slice(0, 6);

  return assumptions.length > 0
    ? assumptions
    : ['Portion size and preparation details were inferred.'];
}

/**
 * Validate and normalize a parsed model response.
 * Invalid items are rejected rather than coerced into plausible-looking zeros.
 *
 * @param {unknown} payload
 * @param {{sourceType?: string, idFactory?: () => string}} options
 * @returns {{foods: Array, rejected: Array, warnings: Array}}
 */
export function validateAIResponse(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.foods)) {
    throw new Error('AI response must contain a foods array');
  }
  if (payload.foods.length === 0) {
    throw new Error('AI response did not contain any foods');
  }
  if (payload.foods.length > LIMITS.maxItems) {
    throw new Error(`AI response contains more than ${LIMITS.maxItems} foods`);
  }

  const {
    sourceType = 'ai-text',
    idFactory = newId,
  } = options;
  const foods = [];
  const rejected = [];
  const warnings = [];

  payload.foods.forEach((raw, index) => {
    const itemErrors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected.push({ index, errors: ['Item must be an object'] });
      return;
    }

    const name = cleanText(raw.name, LIMITS.nameLength);
    const quantity = finiteInRange(raw.portion_grams ?? raw.quantity, LIMITS.quantity);
    const unit = raw.portion_grams != null
      ? 'g'
      : cleanText(raw.unit, LIMITS.unitLength).toLowerCase();
    const calories = finiteInRange(raw.calories, LIMITS.calories);
    const protein = finiteInRange(raw.protein, LIMITS.macroGrams);
    const carbs = finiteInRange(raw.carbs, LIMITS.macroGrams);
    const fat = finiteInRange(raw.fat, LIMITS.macroGrams);
    const confidence = finiteInRange(raw.confidence ?? 0.5, LIMITS.confidence);

    if (!name) itemErrors.push('Name is required');
    if (quantity === null) itemErrors.push('Quantity is missing or outside the supported range');
    if (!unit) itemErrors.push('Unit is required');
    if (calories === null) itemErrors.push('Calories are missing or outside the supported range');
    if (protein === null) itemErrors.push('Protein is missing or outside the supported range');
    if (carbs === null) itemErrors.push('Carbohydrates are missing or outside the supported range');
    if (fat === null) itemErrors.push('Fat is missing or outside the supported range');
    if (confidence === null) itemErrors.push('Confidence must be between 0 and 1');

    if (itemErrors.length > 0) {
      rejected.push({ index, name: name || undefined, errors: itemErrors });
      return;
    }

    const itemWarnings = [];
    const macroCalories = protein * 4 + carbs * 4 + fat * 9;
    if (calories > 0 && macroCalories > calories * 1.75) {
      itemWarnings.push('Macro calories are substantially higher than the calorie estimate.');
    }
    if (confidence < 0.5) {
      itemWarnings.push('The model reported low confidence.');
    }

    const assumptions = normalizeAssumptions(raw.assumptions);
    foods.push({
      id: idFactory(),
      name,
      servingSize: { quantity, unit },
      nutrients: {
        energy: { kcal: calories },
        macros: {
          protein: { g: protein },
          carbs: { g: carbs },
          fat: { g: fat },
        },
        fiber: { g: null },
        sodium: { mg: null },
      },
      source: { type: sourceType, confidence },
      _aiMeta: {
        schemaVersion: AI_RESULT_SCHEMA_VERSION,
        estimated: true,
        confidence,
        assumptions,
        warnings: itemWarnings,
      },
    });

    for (const warning of itemWarnings) {
      warnings.push({ index, name, warning });
    }
  });

  if (foods.length === 0) {
    throw new Error('AI response did not contain any valid food estimates');
  }

  return { schemaVersion: AI_RESULT_SCHEMA_VERSION, foods, rejected, warnings };
}

export { LIMITS };
