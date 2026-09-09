import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADD_DRAFT_STORAGE_KEY,
  clearAddDraft,
  clearAddDraftIfCurrent,
  clearAddDraftIfCurrentLocked,
  createAddDraft,
  createDraftItem,
  createDraftItemFromMealItem,
  getDraftNutrition,
  getDraftTotals,
  isAddDraftCurrent,
  loadAddDraft,
  loadAddDraftForDestination,
  rebaseFoodNutritionForPortion,
  restoreAddDraftIfVacant,
  saveAddDraft,
  saveAddDraftIfCurrent,
  toMealItem,
  updateDraftItem,
  withAddDraftLock,
} from '../src/data/add-draft.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function serialLockManager() {
  const tails = new Map();
  return {
    request(name, _options, operation) {
      const prior = tails.get(name) || Promise.resolve();
      const result = prior.then(() => operation());
      tails.set(name, result.catch(() => {}));
      return result;
    },
  };
}

const rice = {
  id: 'food-rice',
  name: 'Cooked rice',
  servingSize: { quantity: 200, unit: 'g', aliases: [] },
  nutrients: {
    energy: { kcal: 400 },
    macros: {
      protein: { g: 30 },
      carbs: { g: 70 },
      fat: { g: 4 },
    },
    fiber: { g: 2 },
    sodium: { mg: 10 },
  },
  source: { type: 'local' },
};

test('draft portions scale from an immutable nutrition basis', () => {
  const item = createDraftItem(rice, { quantity: 200 });
  const changed = updateDraftItem(item, { quantity: 100 });

  assert.equal(item.basisSnapshot.quantity, 200);
  assert.equal(item.nutrients.kcal, 400);
  assert.equal(changed.basisSnapshot.quantity, 200);
  assert.deepEqual(changed.nutrients, {
    kcal: 200,
    protein: 15,
    carbs: 35,
    fat: 2,
    fiber: 1,
    sodium: 5,
  });
});

test('nutrient corrections describe the displayed portion without double scaling', () => {
  const correctedFood = rebaseFoodNutritionForPortion(rice, {
    quantity: 100,
    unit: 'g',
    nutrients: { kcal: 180, protein: 14 },
  });
  const correctedItem = createDraftItem(correctedFood, { quantity: 100, unit: 'g' });

  assert.equal(correctedItem.nutrients.kcal, 180);
  assert.equal(correctedItem.nutrients.protein, 14);
  assert.equal(correctedItem.provenance.providerBasis.nutrients.kcal, 400);
  assert.equal(createDraftItem(correctedFood, { quantity: 50, unit: 'g' }).nutrients.kcal, 90);
});

test('draft portions deterministically convert compatible mass units', () => {
  const item = createDraftItem(rice, { quantity: 7.05479, unit: 'oz' });
  const nutrients = getDraftNutrition(item);
  assert.equal(nutrients.kcal, 400);
  assert.equal(nutrients.protein, 30);
});

test('unfinished mixed-source drafts survive reload and keep their destination', () => {
  const storage = memoryStorage();
  let draft = createAddDraft({ date: '2026-09-05', mealType: 'lunch' });
  draft.items.push(createDraftItem(rice, { inputMethod: 'searched' }));
  draft.items.push(createDraftItem({
    ...rice,
    id: 'scan-cola',
    name: 'Cola',
    source: { type: 'openFoodFacts' },
  }, { inputMethod: 'scanned' }));
  draft = saveAddDraft(draft, storage);

  const restored = loadAddDraft({
    storage,
    date: '2026-09-08',
    mealType: 'dinner',
  });
  assert.equal(restored.date, '2026-09-05');
  assert.equal(restored.mealType, 'lunch');
  assert.equal(restored.items.length, 2);
  assert.equal(restored.items[1].provenance.inputMethod, 'scanned');

  clearAddDraft(storage);
  assert.equal(storage.getItem(ADD_DRAFT_STORAGE_KEY), null);
});

test('draft cleanup is best-effort when browser storage is blocked', () => {
  const blockedStorage = {
    removeItem() {
      throw new DOMException('Storage is blocked', 'SecurityError');
    },
  };

  assert.equal(clearAddDraft(blockedStorage), false);
});

test('malformed stored items are discarded so Add can recover', () => {
  const storage = memoryStorage();
  storage.setItem(ADD_DRAFT_STORAGE_KEY, JSON.stringify({
    ...createAddDraft({ date: '2026-07-27', mealType: 'lunch' }),
    items: [null],
  }));

  const recovered = loadAddDraft({ storage, date: '2026-07-27', mealType: 'lunch' });
  assert.deepEqual(recovered.items, []);
  assert.equal(storage.getItem(ADD_DRAFT_STORAGE_KEY), null);
});

test('exact AI retries reuse a deterministic food identity', () => {
  const estimate = {
    ...rice,
    id: 'ai-random-id',
    source: { type: 'ai-text' },
    _aiMeta: { estimated: true, assumptions: ['Cooked weight assumed'] },
  };
  const first = createDraftItem(estimate, { inputMethod: 'typed' });
  const retry = createDraftItem({ ...estimate, id: 'ai-another-id' }, { inputMethod: 'typed' });
  assert.equal(first.foodId, retry.foodId);
  assert.equal(first.provenance.nutritionSource, 'AI estimate');
});

test('materially different AI estimates do not share a catalog identity', () => {
  const first = createDraftItem({
    ...rice,
    id: 'ai-first',
    source: { type: 'ai-text' },
    _aiMeta: { estimated: true, assumptions: ['Cooked weight'] },
  });
  const second = createDraftItem({
    ...rice,
    id: 'ai-second',
    servingSize: { quantity: 100, unit: 'g', aliases: [] },
    nutrients: {
      ...rice.nutrients,
      energy: { kcal: 165 },
      macros: { ...rice.nutrients.macros, protein: { g: 31 } },
    },
    source: { type: 'ai-text' },
    _aiMeta: { estimated: true, assumptions: ['Grilled weight'] },
  });

  assert.notEqual(first.foodId, second.foodId);
});

test('familiar meals preserve their snapshotted nutrition basis', () => {
  const item = createDraftItemFromMealItem({
    foodId: rice.id,
    nameSnapshot: 'Historical rice',
    quantity: 100,
    unit: 'g',
    nutrients: { kcal: 190, protein: 14, carbs: 34, fat: 2 },
    basisSnapshot: {
      quantity: 200,
      unit: 'g',
      label: '1 cooked portion (200 g)',
      nutrients: { kcal: 380, protein: 28, carbs: 68, fat: 4 },
    },
  }, { ...rice, name: 'Renamed catalog rice' });
  assert.equal(item.nameSnapshot, 'Historical rice');
  assert.equal(item.basisSnapshot.label, '1 cooked portion (200 g)');
  assert.equal(item.nutrients.kcal, 190);
  assert.equal(updateDraftItem(item, { quantity: 50 }).nutrients.kcal, 95);
});

test('a stale tab cannot clear or submit over a newer persisted draft', () => {
  const storage = memoryStorage();
  let first = createAddDraft({ date: '2026-09-05', mealType: 'lunch' });
  first.items.push(createDraftItem(rice));
  first = saveAddDraft(first, storage);
  const stale = structuredClone(first);

  const newer = saveAddDraft({
    ...first,
    items: [...first.items, createDraftItem({ ...rice, id: 'food-beans', name: 'Beans' })],
  }, storage);
  assert.equal(isAddDraftCurrent(stale, storage), false);
  assert.equal(clearAddDraftIfCurrent(stale, storage), false);
  assert.equal(isAddDraftCurrent(newer, storage), true);
  assert.equal(clearAddDraftIfCurrent(newer, storage), true);
});

test('the draft lock makes concurrent compare-and-write operations single-writer', async () => {
  const storage = memoryStorage();
  const locks = serialLockManager();
  const base = saveAddDraft(createAddDraft({ date: '2026-09-05', mealType: 'lunch' }), storage);
  const firstTab = structuredClone(base);
  const secondTab = structuredClone(base);
  const firstItem = createDraftItem(rice);
  const secondItem = createDraftItem({ ...rice, id: 'food-beans', name: 'Beans' });

  const results = await Promise.all([
    saveAddDraftIfCurrent(firstTab, { ...firstTab, items: [firstItem] }, { storage, lockManager: locks }),
    saveAddDraftIfCurrent(secondTab, { ...secondTab, items: [secondItem] }, { storage, lockManager: locks }),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  const persisted = loadAddDraft({ storage });
  assert.equal(persisted.items.length, 1);
  assert.equal(await clearAddDraftIfCurrentLocked(persisted, { storage, lockManager: locks }), true);
});

test('retargeting a restored empty draft keeps its compare-and-write revision current', async () => {
  const storage = memoryStorage();
  const locks = serialLockManager();
  let draft = createAddDraft({ date: '2026-09-05', mealType: 'lunch' });
  draft = saveAddDraft({ ...draft, items: [createDraftItem(rice)] }, storage);
  draft = saveAddDraft({ ...draft, items: [] }, storage);

  const retargeted = await loadAddDraftForDestination({
    storage,
    date: '2026-09-06',
    mealType: 'dinner',
    lockManager: locks,
  });
  assert.equal(retargeted.date, '2026-09-06');
  assert.equal(retargeted.mealType, 'dinner');
  assert.equal(isAddDraftCurrent(retargeted, storage), true);

  const saved = await saveAddDraftIfCurrent(retargeted, {
    ...retargeted,
    items: [createDraftItem(rice)],
  }, { storage, lockManager: locks });
  assert.equal(saved.items.length, 1);
});

test('the draft lock keeps undo restore and meal removal indivisible from a re-save', async () => {
  const storage = memoryStorage();
  const locks = serialLockManager();
  const savedDraft = saveAddDraft({
    ...createAddDraft({ date: '2026-09-05', mealType: 'lunch' }),
    items: [createDraftItem(rice)],
  }, storage);
  clearAddDraft(storage);
  let mealExists = true;

  const undo = withAddDraftLock(async () => {
    const restored = restoreAddDraftIfVacant(savedDraft, storage);
    assert.ok(restored);
    await Promise.resolve();
    mealExists = false;
    return restored;
  }, locks);
  const resave = withAddDraftLock(() => {
    const current = loadAddDraft({ storage });
    assert.equal(isAddDraftCurrent(current, storage), true);
    mealExists = true;
    clearAddDraftIfCurrent(current, storage);
  }, locks);

  await Promise.all([undo, resave]);
  assert.equal(mealExists, true);
  assert.equal(storage.getItem(ADD_DRAFT_STORAGE_KEY), null);
});

test('meal serialization omits provisional food records and totals mixed items', () => {
  const first = createDraftItem(rice, { quantity: 100 });
  const second = createDraftItem(rice, { quantity: 50, inputMethod: 'scanned' });
  const totals = getDraftTotals({ items: [first, second] });
  const mealItem = toMealItem(first);

  assert.equal(totals.kcal, 300);
  assert.equal(totals.protein, 22.5);
  assert.deepEqual(totals.incomplete, []);
  assert.equal('foodSnapshot' in mealItem, false);
  assert.equal(mealItem.basisSnapshot.quantity, 200);
});

test('draft totals mark missing nutrients as unknown instead of reporting zero', () => {
  const incompleteFood = structuredClone(rice);
  incompleteFood.nutrients.macros.protein.g = null;
  const totals = getDraftTotals({ items: [createDraftItem(incompleteFood)] });

  assert.equal(totals.protein, 0);
  assert.equal(totals.incomplete.includes('protein'), true);
  assert.equal(totals.incomplete.includes('kcal'), false);
});

test('a compatible portion remains editable when calories are unknown', () => {
  const incompleteFood = structuredClone(rice);
  incompleteFood.nutrients.energy.kcal = null;
  const item = createDraftItem(incompleteFood, { quantity: 200, unit: 'g' });
  const changed = updateDraftItem(item, { quantity: 100 });

  assert.equal(changed.quantity, 100);
  assert.equal(changed.nutrients.kcal, null);
  assert.equal(changed.nutrients.protein, 15);
});
