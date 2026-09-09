import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_SCHEMA_VERSION, validateBackupData } from '../src/data/db.js';

const validBackup = {
  version: 1,
  stores: {
    foods: [{
      id: 'food-1',
      name: 'Fixture',
      servingSize: { quantity: 100, unit: 'g' },
      nutrients: {
        energy: { kcal: 100 },
        macros: { protein: { g: 1 }, carbs: { g: 2 }, fat: { g: 3 } },
        fiber: { g: null },
        sodium: { mg: null },
      },
    }],
    settings: [{ key: 'theme', value: 'compline' }],
  },
};

test('accepts recognized stores with valid keys', () => {
  assert.deepEqual(validateBackupData(validBackup), ['foods', 'settings']);
});

test('rejects malformed backup containers before opening a transaction', () => {
  assert.throws(() => validateBackupData(null), /JSON object/i);
  assert.throws(() => validateBackupData({}), /data stores/i);
  assert.throws(() => validateBackupData({ version: 1, stores: { unknown: [] } }), /recognized/i);
});

test('rejects malformed records before replacement can clear data', () => {
  assert.throws(
    () => validateBackupData({ version: 1, stores: { foods: [{ name: 'No ID' }] } }),
    /valid id/i,
  );
  assert.throws(
    () => validateBackupData({ version: 1, stores: { settings: [{ value: true }] } }),
    /valid key/i,
  );
  assert.throws(
    () => validateBackupData({
      version: 1,
      stores: { meals: [{ id: 'meal-1', date: 'not-a-date', type: 'invalid', items: 'broken' }] },
    }),
    /valid date/i,
  );
  assert.throws(
    () => validateBackupData({
      version: 1,
      stores: {
        meals: [{
          id: 'meal-1',
          date: '2026-08-13',
          type: 'lunch',
          items: [{ foodId: 'food-1', quantity: -1, unit: 'g' }],
        }],
      },
    }),
    /positive number/i,
  );
  assert.throws(
    () => validateBackupData({
      version: 1,
      stores: {
        measurements: [{
          id: 'measurement-1',
          date: '2026-08-13',
          weight: 70,
          unit: 'kg',
          bodyFat: '<img src=x onerror=alert(1)>',
        }],
      },
    }),
    /body fat.*between 0 and 100/i,
  );
});

test('rejects negative nutrition values in nested foods and flat meal snapshots', () => {
  const negativeFood = structuredClone(validBackup);
  negativeFood.stores.foods[0].nutrients.energy.kcal = -1;
  assert.throws(() => validateBackupData(negativeFood), /calories.*non-negative/i);

  assert.throws(
    () => validateBackupData({
      version: 1,
      stores: {
        meals: [{
          id: 'meal-1',
          date: '2026-08-13',
          type: 'lunch',
          items: [{
            foodId: 'food-1',
            quantity: 1,
            unit: 'serving',
            nutrients: { kcal: 100, protein: -2, carbs: 3, fat: 4 },
          }],
        }],
      },
    }),
    /protein.*non-negative/i,
  );
});

test('rejects non-string fields that may later be rendered', () => {
  for (const [field, value] of [
    ['brand', ['<img src=x onerror=alert(1)>']],
    ['category', { markup: '<svg onload=alert(1)>' }],
  ]) {
    const backup = structuredClone(validBackup);
    backup.stores.foods[0][field] = value;
    assert.throws(() => validateBackupData(backup), new RegExp(`food ${field}.*string`, 'i'));
  }

  const invalidSource = structuredClone(validBackup);
  invalidSource.stores.foods[0].source = { type: ['<img src=x onerror=alert(1)>'] };
  assert.throws(() => validateBackupData(invalidSource), /food source type.*string/i);

  for (const [field, value, label] of [
    ['nameSnapshot', ['<img src=x onerror=alert(1)>'], 'name'],
    ['notes', { markup: '<svg onload=alert(1)>' }, 'notes'],
    ['itemId', ['<script>alert(1)</script>'], 'ID'],
  ]) {
    assert.throws(
      () => validateBackupData({
        version: 1,
        stores: {
          meals: [{
            id: 'meal-1',
            date: '2026-08-13',
            type: 'lunch',
            items: [{ foodId: 'food-1', quantity: 1, unit: 'g', [field]: value }],
          }],
        },
      }),
      new RegExp(`meal item ${label}.*string`, 'i'),
    );
  }
});

test('rejects unsupported schema version shapes', () => {
  assert.throws(
    () => validateBackupData({ ...validBackup, version: '1' }),
    /schema version/i,
  );
  assert.throws(
    () => validateBackupData({ ...validBackup, version: 2 }),
    /not supported/i,
  );
  assert.throws(
    () => validateBackupData({ ...validBackup, dataVersion: DATA_SCHEMA_VERSION + 1 }),
    /not supported/i,
  );
});

test('accepts legacy Ollama settings so import can safely discard remote endpoints', () => {
  assert.deepEqual(validateBackupData({
    version: 1,
    stores: {
      settings: [{ key: 'ai_ollama_url', value: 'https://ollama.example.com' }],
    },
  }), ['settings']);

  assert.deepEqual(validateBackupData({
    version: 1,
    stores: {
      settings: [{ key: 'ai_ollama_url', value: 'http://127.0.0.1:11434' }],
    },
  }), ['settings']);
});

test('rejects malformed AI usage entries before they can brick Settings', () => {
  assert.throws(
    () => validateBackupData({
      version: 1,
      stores: { settings: [{ key: 'ai_usage_log', value: [null] }] },
    }),
    /usage log.*invalid entry/i,
  );
  assert.throws(
    () => validateBackupData({
      version: 1,
      stores: {
        settings: [{
          key: 'ai_usage_log',
          value: [{ date: '2026-09-09T12:00:00.000Z', provider: 'openai', tokens: '<img>', cost: 0 }],
        }],
      },
    }),
    /invalid tokens/i,
  );
});

test('bounds record count before import work begins', () => {
  assert.throws(
    () => validateBackupData({
      version: 1,
      stores: { foods: Array.from({ length: 250_001 }, (_, index) => ({ id: `food-${index}` })) },
    }),
    /too many records/i,
  );
});
