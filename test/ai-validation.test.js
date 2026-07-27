import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_RESULT_SCHEMA_VERSION,
  validateAIResponse,
  LIMITS,
} from '../src/integrations/aiValidation.js';

const validFood = {
  name: 'Rice bowl',
  quantity: 1,
  unit: 'bowl',
  calories: 520,
  protein: 18,
  carbs: 82,
  fat: 14,
  confidence: 0.72,
  assumptions: ['One medium bowl', 'Sauce included'],
};

test('normalizes valid AI food without paid provider calls', () => {
  const result = validateAIResponse(
    { foods: [validFood] },
    { now: () => 123, sourceType: 'ai-voice', idPrefix: 'fixture' },
  );
  assert.equal(result.foods.length, 1);
  assert.equal(result.schemaVersion, AI_RESULT_SCHEMA_VERSION);
  assert.equal(result.foods[0].id, 'fixture-123-0');
  assert.equal(result.foods[0].servingSize.quantity, 1);
  assert.equal(result.foods[0].nutrients.energy.kcal, 520);
  assert.deepEqual(result.foods[0]._aiMeta.assumptions, ['One medium bowl', 'Sauce included']);
  assert.equal(result.foods[0].nutrients.sodium.mg, null);
  assert.equal(result.foods[0]._aiMeta.schemaVersion, AI_RESULT_SCHEMA_VERSION);
});

test('uses portion_grams as a gram serving', () => {
  const result = validateAIResponse({
    foods: [{ ...validFood, quantity: undefined, unit: undefined, portion_grams: 275 }],
  }, { now: () => 1 });
  assert.deepEqual(result.foods[0].servingSize, { quantity: 275, unit: 'g' });
});

test('adds an explicit default assumption when the provider omits one', () => {
  const result = validateAIResponse({
    foods: [{ ...validFood, assumptions: undefined }],
  });
  assert.match(result.foods[0]._aiMeta.assumptions[0], /inferred/i);
});

test('rejects negative nutrition instead of coercing it to zero', () => {
  assert.throws(
    () => validateAIResponse({ foods: [{ ...validFood, calories: -1 }] }),
    /valid food estimates/i,
  );
});

test('rejects non-finite and implausibly large fields', () => {
  const result = validateAIResponse({
    foods: [
      validFood,
      { ...validFood, name: 'Infinity item', calories: Infinity },
      { ...validFood, name: 'Huge item', quantity: LIMITS.quantity[1] + 1 },
    ],
  });
  assert.equal(result.foods.length, 1);
  assert.equal(result.rejected.length, 2);
});

test('rejects missing required macros', () => {
  assert.throws(
    () => validateAIResponse({ foods: [{ ...validFood, protein: undefined }] }),
    /valid food estimates/i,
  );
});

test('rejects an invalid outer shape and empty response', () => {
  assert.throws(() => validateAIResponse(null), /foods array/i);
  assert.throws(() => validateAIResponse({ foods: [] }), /any foods/i);
});

test('limits response item count to bound logging work', () => {
  assert.throws(
    () => validateAIResponse({ foods: Array.from({ length: LIMITS.maxItems + 1 }, () => validFood) }),
    /more than/i,
  );
});

test('flags low confidence and inconsistent macro calories', () => {
  const result = validateAIResponse({
    foods: [{ ...validFood, calories: 100, protein: 100, confidence: 0.2 }],
  });
  assert.equal(result.warnings.length, 2);
  assert.equal(result.foods[0]._aiMeta.warnings.length, 2);
});

test('sanitizes and bounds untrusted text fields', () => {
  const result = validateAIResponse({
    foods: [{
      ...validFood,
      name: `  ${'x'.repeat(200)}  `,
      unit: ' BOWL ',
      assumptions: ['  prepared   with oil  '],
    }],
  });
  assert.equal(result.foods[0].name.length, LIMITS.nameLength);
  assert.equal(result.foods[0].servingSize.unit, 'bowl');
  assert.deepEqual(result.foods[0]._aiMeta.assumptions, ['prepared with oil']);
});
