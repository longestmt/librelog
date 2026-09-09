import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  clearAllData,
  getById,
  getSetting,
  hardDeleteAll,
  put,
  setSetting,
  softDelete,
} from '../src/data/db.js';

function abortSuccessfulRequest(t, method) {
  const prototype = globalThis.IDBObjectStore.prototype;
  const original = prototype[method];
  t.mock.method(prototype, method, function abortAfterSuccess(...args) {
    const request = original.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  });
}

function food(id) {
  return {
    id,
    name: 'Commit test food',
    servingSize: { quantity: 100, unit: 'g', aliases: [] },
    nutrients: {
      energy: { kcal: 100 },
      macros: {
        protein: { g: 1 },
        carbs: { g: 2 },
        fat: { g: 3 },
      },
      fiber: { g: null },
      sodium: { mg: null },
    },
  };
}

test('put rejects when its transaction aborts after request success', async t => {
  await clearAllData();
  abortSuccessfulRequest(t, 'put');

  await assert.rejects(put('foods', food('aborted-put')), /aborted|failed/i);
  assert.equal(await getById('foods', 'aborted-put'), null);
});

test('softDelete does not report success before its transaction commits', async t => {
  await clearAllData();
  await put('foods', food('aborted-delete'));
  abortSuccessfulRequest(t, 'put');

  await assert.rejects(softDelete('foods', 'aborted-delete'), /aborted|failed/i);
  assert.notEqual(await getById('foods', 'aborted-delete'), null);
});

test('hardDeleteAll rejects when its clear transaction aborts', async t => {
  await clearAllData();
  await put('foods', food('aborted-clear'));
  abortSuccessfulRequest(t, 'clear');

  await assert.rejects(hardDeleteAll('foods'), /aborted|failed/i);
  assert.notEqual(await getById('foods', 'aborted-clear'), null);
});

test('setSetting rejects when its transaction aborts after request success', async t => {
  await clearAllData();
  abortSuccessfulRequest(t, 'put');

  await assert.rejects(setSetting('commit-test', 'not-committed'), /aborted|failed/i);
  assert.equal(await getSetting('commit-test', null), null);
});
