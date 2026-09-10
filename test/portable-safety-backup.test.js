import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  clearAllData,
  getSetting,
  put,
  setSetting,
} from '../src/data/db.js';
import { createPortableSafetyBackup } from '../src/data/portable-safety-backup.js';

const FOOD = {
  id: 'portable-safety-food',
  name: 'Portable safety sentinel',
  servingSize: { quantity: 1, unit: 'serving', aliases: [] },
  nutrients: {
    energy: { kcal: 123 },
    macros: { protein: { g: 4 }, carbs: { g: 5 }, fat: { g: 6 } },
    fiber: { g: 1 },
    sodium: { mg: 2 },
  },
};

test('join safety backup saves and verifies a portable credential-free artifact', async () => {
  await clearAllData();
  await put('foods', FOOD);
  await setSetting('theme', 'lauds');
  await setSetting('ai_api_key', 'must-never-leave-this-profile');
  let written;

  const result = await createPortableSafetyBackup({
    clock: () => new Date('2026-09-01T12:34:56.789Z'),
    persistArtifact: async artifact => {
      written = artifact;
      return { method: 'test-file', readback: await artifact.blob.text() };
    },
  });

  assert.deepEqual(result, {
    verified: true,
    filename: 'librelog-before-sync-2026-09-01T12-34-56-789Z.json',
    method: 'test-file',
  });
  assert.equal(written.blob.type, 'application/json');
  const backup = JSON.parse(written.serialized);
  assert.equal(backup.stores.foods[0].name, FOOD.name);
  assert.equal(backup.stores.settings.some(record => record.key === 'theme'), true);
  assert.equal(backup.stores.settings.some(record => record.key === 'ai_api_key'), false);
  assert.equal(written.serialized.includes('must-never-leave-this-profile'), false);
  assert.ok(Number(await getSetting('lastPortableBackupTime')) > 0);
});

test('an unverified portable write rejects and does not mark a safety backup complete', async () => {
  await clearAllData();
  await put('foods', FOOD);

  await assert.rejects(
    createPortableSafetyBackup({
      persistArtifact: async () => ({ method: 'broken-file', readback: '{"truncated":true}' }),
    }),
    /could not be verified/i,
  );
  assert.equal(await getSetting('lastPortableBackupTime', null), null);
});
