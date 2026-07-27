import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackupData } from '../src/data/db.js';

const validBackup = {
  version: 1,
  stores: {
    foods: [{ id: 'food-1', name: 'Fixture' }],
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
    () => validateBackupData({ ...validBackup, dataVersion: 2 }),
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
