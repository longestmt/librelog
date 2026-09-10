import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  clearAllData,
  put,
  setSetting,
  softDelete,
} from '../src/data/db.js';
import {
  chunkLocalChanges,
  readLibreLogLocalEntities,
} from '../src/sync/local-entities.js';

test('bootstrap enumeration covers app data and excludes local-only state', async () => {
  await clearAllData();
  await put('foods', { id: 'food-a', name: 'Food A' });
  await put('meals', { id: 'meal-a', date: '2026-09-01', type: 'lunch', items: [] });
  await put('recipes', { id: 'recipe-a', name: 'Recipe A', items: [] });
  await put('measurements', { id: 'measurement-a', date: '2026-09-01', weight: 80, unit: 'kg' });
  await setSetting('nutritionGoals', { calorieTarget: 2000 });
  await setSetting('theme', 'lauds');
  await setSetting('unit', 'metric');
  await setSetting('note_2026-09-01', 'note');
  await setSetting('template_a', { name: 'Template', items: [] });
  await setSetting('ai_api_key', 'never-sync');
  await setSetting('initialized', true);
  await put('apiCache', { id: 'private-query', query: 'never-sync' });

  const changes = await readLibreLogLocalEntities();
  assert.deepEqual(
    new Set(changes.map(change => change.entityType)),
    new Set(['foods', 'meals', 'recipes', 'measurements', 'settings']),
  );
  assert.equal(changes.filter(change => change.entityType === 'settings').length, 5);
  assert.equal(JSON.stringify(changes).includes('never-sync'), false);
});

test('bulk local operations are bounded below protocol maxChanges', () => {
  const changes = Array.from({ length: 513 }, (_, index) => ({ entityId: String(index) }));
  const chunks = chunkLocalChanges(changes);
  assert.deepEqual(chunks.map(chunk => chunk.length), [200, 200, 113]);
  assert.throws(() => chunkLocalChanges(changes, 257), /1 to 256/);
});

test('pre-join enumeration preserves domain tombstones', async () => {
  await clearAllData();
  await put('foods', { id: 'locally-deleted-food', name: 'Deleted before pairing' });
  await softDelete('foods', 'locally-deleted-food');

  const changes = await readLibreLogLocalEntities();
  assert.deepEqual(changes.find(change => change.entityId === 'locally-deleted-food'), {
    entityType: 'foods',
    entityId: 'locally-deleted-food',
    kind: 'delete',
  });
});
