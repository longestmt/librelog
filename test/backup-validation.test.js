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

test('bounds record count before import work begins', () => {
  assert.throws(
    () => validateBackupData({
      version: 1,
      stores: { foods: Array.from({ length: 250_001 }, (_, index) => ({ id: `food-${index}` })) },
    }),
    /too many records/i,
  );
});
