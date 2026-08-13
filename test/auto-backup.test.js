import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, getSetting } from '../src/data/db.js';
import { performBackup } from '../src/data/auto-backup.js';

test('failed browser storage does not report a successful automatic backup', async () => {
  await clearAllData();
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() { throw new Error('Quota exceeded'); },
    removeItem() {},
  };

  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    assert.equal(await performBackup(), false);
    assert.equal(await getSetting('lastBackupTime', null), null);
    assert.equal(await getSetting('lastBackupMethod', null), null);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test('verified browser storage records backup success', async () => {
  await clearAllData();
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };

  assert.equal(await performBackup(), true);
  assert.equal(await getSetting('lastBackupMethod'), 'localStorage');
  assert.ok(Number(await getSetting('lastBackupTime')) > 0);
  assert.ok(values.get('librelog_backups'));
});
