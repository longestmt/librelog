import { now, openDB, uuid } from './db.js';
import {
  assertDataMutationGenerationCurrent,
  captureDataMutationGeneration,
  hasDataWriteLock,
  withDataWriteLock,
} from './operation-locks.js';
import {
  recordLibreLogChanges,
  storesForLocalMutation,
  waitForTransaction,
} from '../sync/atomic.js';
import { toSyncChange } from '../sync/policy.js';

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snacks']);
const MAX_APPLIED_COMMAND_KEYS = 20;

function withMaybeDataWriteLock(operation, {
  destructiveLockToken,
  mutationGuardToken,
  mutationGeneration = captureDataMutationGeneration(),
  writeLockToken,
  lockManager,
} = {}) {
  const guardedOperation = () => {
    assertDataMutationGenerationCurrent(mutationGeneration);
    return operation();
  };
  if (hasDataWriteLock(writeLockToken)) return guardedOperation();
  return withDataWriteLock(guardedOperation, lockManager, {
    destructiveLockToken,
    mutationGuardToken,
  });
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[a-zA-Z0-9._:-]{8,160}$/.test(key)) {
    throw new Error('Meal write requires a valid idempotency key');
  }
  return key;
}

export function createIdempotencyKey(prefix = 'meal') {
  return `${prefix}:${uuid()}`;
}

export function createDeterministicKey(prefix, value) {
  const text = String(value ?? '');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${prefix}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function validateMealItem(item) {
  if (!item || typeof item.foodId !== 'string' || !item.foodId) {
    throw new Error('Each meal item requires a food ID');
  }
  if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) {
    throw new Error('Each meal item requires a positive quantity');
  }
  if (typeof item.unit !== 'string' || !item.unit.trim()) {
    throw new Error('Each meal item requires a unit');
  }
  const record = structuredClone(item);
  const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : '';
  record.itemId = itemId || uuid();
  return record;
}

export function validateMealInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Meal must be an object');
  }
  if (!isCalendarDate(input.date)) {
    throw new Error('Meal requires a valid calendar date');
  }
  const type = String(input.type || '').toLowerCase();
  if (!MEAL_TYPES.has(type)) {
    throw new Error('Meal requires a valid meal type');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Meal requires at least one item');
  }
  const seenItemIds = new Set();
  const items = input.items.map(item => {
    const record = validateMealItem(item);
    if (seenItemIds.has(record.itemId)) record.itemId = uuid();
    seenItemIds.add(record.itemId);
    return record;
  });
  return { ...input, type, items };
}

/**
 * Create one meal record. A repeated command with the same key returns the
 * first record and does not create a second record.
 */
async function createMealWithWriteLockHeld(input, {
  idempotencyKey,
  relatedFoods = [],
  catalogPreferences = [],
  context,
} = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const validated = validateMealInput(input);
  if (!Array.isArray(relatedFoods)) throw new Error('Related foods must be an array');
  if (!Array.isArray(catalogPreferences)) throw new Error('Catalog preferences must be an array');
  const normalizedFoods = relatedFoods
    .filter(food => food != null)
    .map(food => {
      if (typeof food !== 'object' || Array.isArray(food)) {
        throw new Error('Related foods must be records');
      }
      const foodId = String(food.id || '').trim();
      if (!foodId) throw new Error('Related foods require an ID');
      return { ...structuredClone(food), id: foodId };
    });
  const uniqueFoods = [...new Map(normalizedFoods.map(food => [food.id, food])).values()];
  const normalizedPreferences = catalogPreferences.map(preference => {
    if (!preference || typeof preference !== 'object' || Array.isArray(preference)) {
      throw new Error('Catalog preferences must be records');
    }
    const foodId = String(preference.foodId || '').trim();
    if (!foodId) throw new Error('Catalog preferences require a food ID');
    const normalized = { foodId };
    if (Object.hasOwn(preference, 'favorite')) {
      if (typeof preference.favorite !== 'boolean') {
        throw new Error('Favorite preference must be true or false');
      }
      normalized.favorite = preference.favorite;
    }
    if (Object.hasOwn(preference, 'usualServing')) {
      if (preference.usualServing == null) {
        normalized.usualServing = null;
      } else {
        const quantity = Number(preference.usualServing.quantity);
        const unit = String(preference.usualServing.unit || '').trim();
        if (!Number.isFinite(quantity) || quantity <= 0 || !unit) {
          throw new Error('Usual serving preference requires a positive quantity and unit');
        }
        normalized.usualServing = { quantity, unit };
      }
    }
    if (!Object.hasOwn(normalized, 'favorite') && !Object.hasOwn(normalized, 'usualServing')) {
      throw new Error('Catalog preferences require a supported field');
    }
    return normalized;
  });
  const uniquePreferences = [...new Map(normalizedPreferences
    .map(preference => [preference.foodId, preference])).values()];
  const provisionalFoods = new Map(uniqueFoods.map(food => [food.id, food]));
  const preferenceByFood = new Map(uniquePreferences
    .map(preference => [preference.foodId, preference]));
  const foodIds = [...new Set([
    ...provisionalFoods.keys(),
    ...preferenceByFood.keys(),
  ])];
  const db = await openDB();
  const transaction = db.transaction(storesForLocalMutation(['foods', 'meals']), 'readwrite');
  const completion = waitForTransaction(transaction);
  const foodsStore = transaction.objectStore('foods');
  const mealsStore = transaction.objectStore('meals');
  try {
    const [existing, ...existingFoods] = await Promise.all([
      transactionRequest(mealsStore.index('idempotencyKey').get(key)),
      ...foodIds.map(foodId => transactionRequest(foodsStore.get(foodId))),
    ]);
    if (existing) {
      await completion;
      return { meal: existing, created: false };
    }

    const timestamp = now();
    const writtenFoods = [];
    // Related foods are provisional dependencies, not catalog updates. Existing
    // (including soft-deleted) records win so historical data cannot roll back
    // catalog edits or resurrect a deleted item.
    foodIds.forEach((foodId, index) => {
      const existingFood = existingFoods[index];
      if (existingFood?.deleted) return;
      const provisionalFood = provisionalFoods.get(foodId);
      if (!existingFood && !provisionalFood) {
        throw new Error('Catalog preferences require a related or existing food');
      }
      const preference = preferenceByFood.get(foodId);
      if (existingFood && !preference) return;

      const record = existingFood
        ? { ...existingFood, updatedAt: timestamp }
        : {
          ...provisionalFood,
          createdAt: provisionalFood.createdAt || timestamp,
          updatedAt: timestamp,
          deleted: false,
        };
      if (Object.hasOwn(preference || {}, 'favorite')) record.favorite = preference.favorite;
      if (Object.hasOwn(preference || {}, 'usualServing')) {
        if (preference.usualServing == null) delete record.usualServing;
        else record.usualServing = structuredClone(preference.usualServing);
      }
      foodsStore.put(record);
      writtenFoods.push(record);
    });

    const meal = {
      ...validated,
      id: uuid(),
      idempotencyKey: key,
      createdAt: validated.createdAt || timestamp,
      updatedAt: timestamp,
      deleted: false,
    };
    mealsStore.put(meal);
    const changes = [
      ...writtenFoods.map(record => toSyncChange('foods', record, 'put')),
      attachContext(toSyncChange('meals', meal, 'put'), context),
    ].filter(Boolean);
    if (changes.length) await recordLibreLogChanges(transaction, changes);
    await completion;
    return { meal, created: true };
  } catch (error) {
    try { transaction.abort(); } catch { /* already closed */ }
    try { await completion; } catch { /* consume transaction failure */ }
    throw error;
  }
}

export async function createMeal(input, options = {}) {
  return withMaybeDataWriteLock(
    () => createMealWithWriteLockHeld(input, options),
    options,
  );
}

function transactionRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function attachContext(change, context) {
  if (change && context !== undefined) change.context = structuredClone(context);
  return change;
}

async function mutateMealWithWriteLockHeld(mealId, idempotencyKey, mutation, { context } = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const db = await openDB();
  const transaction = db.transaction(storesForLocalMutation(['meals']), 'readwrite');
  const completion = waitForTransaction(transaction);
  const store = transaction.objectStore('meals');
  try {
    const meal = await transactionRequest(store.get(mealId));
    if (!meal) throw new Error('Meal was not found');
    if (meal.appliedCommandKeys?.includes(key)) {
      await completion;
      return { meal, changed: false };
    }
    if (meal.deleted) throw new Error('Meal was not found');

    const next = mutation(structuredClone(meal));
    const record = {
      ...next,
      appliedCommandKeys: [...(meal.appliedCommandKeys || []), key]
        .slice(-MAX_APPLIED_COMMAND_KEYS),
      updatedAt: now(),
    };
    store.put(record);
    const change = attachContext(
      toSyncChange('meals', record, record.deleted ? 'delete' : 'put'),
      context,
    );
    if (change) await recordLibreLogChanges(transaction, [change]);
    await completion;
    return { meal: record, changed: true };
  } catch (error) {
    try { transaction.abort(); } catch { /* already closed */ }
    try { await completion; } catch { /* consume transaction failure */ }
    throw error;
  }
}

async function mutateMeal(mealId, idempotencyKey, mutation, options = {}) {
  return withMaybeDataWriteLock(
    () => mutateMealWithWriteLockHeld(mealId, idempotencyKey, mutation, options),
    options,
  );
}

function resolveMealItemIndex(meal, requestedIdentity, expectedItemId) {
  const items = Array.isArray(meal.items) ? meal.items : [];
  if (typeof requestedIdentity === 'string') {
    const itemId = requestedIdentity.trim();
    if (!itemId) throw new Error('Meal item ID is invalid');
    const index = items.findIndex(candidate => candidate.itemId === itemId);
    if (index < 0) throw new Error('Meal item was changed or removed in another tab');
    return index;
  }
  const requestedIndex = Number(requestedIdentity);
  if (!Number.isInteger(requestedIndex) || requestedIndex < 0) {
    throw new Error('Meal item index is invalid');
  }
  if (!expectedItemId) return requestedIndex;
  const currentIndex = items.findIndex(candidate => candidate.itemId === expectedItemId);
  if (currentIndex < 0) throw new Error('Meal item was changed or removed in another tab');
  return currentIndex;
}

export async function updateMealItem(mealId, itemIdentity, item, options = {}) {
  const { idempotencyKey, expectedItemId } = options;
  const validatedItem = validateMealItem(item);
  return mutateMeal(mealId, idempotencyKey, meal => {
    const currentIndex = resolveMealItemIndex(meal, itemIdentity, expectedItemId);
    if (!Array.isArray(meal.items) || !meal.items[currentIndex]) {
      throw new Error('Meal item was not found');
    }
    meal.items[currentIndex] = {
      ...validatedItem,
      itemId: meal.items[currentIndex].itemId,
    };
    return meal;
  }, options);
}

export async function removeMealItem(mealId, itemIdentity, options = {}) {
  const { idempotencyKey, expectedItemId } = options;
  let removedItem = null;
  let removedIndex = -1;
  const result = await mutateMeal(mealId, idempotencyKey, meal => {
    const currentIndex = resolveMealItemIndex(meal, itemIdentity, expectedItemId);
    if (!Array.isArray(meal.items) || !meal.items[currentIndex]) {
      throw new Error('Meal item was not found');
    }
    removedIndex = currentIndex;
    [removedItem] = meal.items.splice(currentIndex, 1);
    removedItem = structuredClone(removedItem);
    if (meal.items.length === 0) meal.deleted = true;
    return meal;
  }, options);
  return { ...result, removedItem, removedIndex };
}

/**
 * Restore one previously removed item without replacing any sibling edits that
 * happened after the removal. This also revives a meal that became empty.
 */
async function restoreMealItemWithWriteLockHeld(
  mealId,
  itemIndex,
  item,
  { idempotencyKey, context } = {},
) {
  const index = Number(itemIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error('Meal item index is invalid');
  const key = normalizeIdempotencyKey(idempotencyKey);
  const restoredItem = validateMealItem(item);
  const db = await openDB();
  const transaction = db.transaction(storesForLocalMutation(['meals']), 'readwrite');
  const completion = waitForTransaction(transaction);
  const store = transaction.objectStore('meals');
  try {
    const meal = await transactionRequest(store.get(mealId));
    if (!meal) throw new Error('Meal was not found');
    if (meal.appliedCommandKeys?.includes(key)) {
      await completion;
      return { meal, changed: false };
    }

    const items = [...(meal.items || [])];
    const alreadyPresent = restoredItem.itemId
      && items.some(existing => existing.itemId === restoredItem.itemId);
    if (alreadyPresent) {
      await completion;
      return { meal, changed: false };
    }
    items.splice(Math.min(index, items.length), 0, restoredItem);
    const record = {
      ...meal,
      items,
      deleted: false,
      appliedCommandKeys: [...(meal.appliedCommandKeys || []), key]
        .slice(-MAX_APPLIED_COMMAND_KEYS),
      updatedAt: now(),
    };
    store.put(record);
    const change = attachContext(toSyncChange('meals', record, 'put'), context);
    if (change) await recordLibreLogChanges(transaction, [change]);
    await completion;
    return { meal: record, changed: true };
  } catch (error) {
    try { transaction.abort(); } catch { /* already closed */ }
    try { await completion; } catch { /* consume transaction failure */ }
    throw error;
  }
}

export async function restoreMealItem(mealId, itemIndex, item, options = {}) {
  return withMaybeDataWriteLock(
    () => restoreMealItemWithWriteLockHeld(mealId, itemIndex, item, options),
    options,
  );
}

async function createMealBatchWithWriteLockHeld(inputs, {
  idempotencyKey,
  idempotencyKeys,
  relatedFoods = [],
  context,
} = {}) {
  if (!Array.isArray(inputs)) throw new Error('Meal batch must be an array');
  if (inputs.length === 0) return [];
  // Validate every record before opening the transaction so a bad tail item
  // cannot leave a successfully written prefix behind.
  const validated = inputs.map(validateMealInput);
  if (!Array.isArray(relatedFoods)) throw new Error('Related foods must be an array');
  const normalizedFoods = relatedFoods.map(food => {
    if (!food || typeof food !== 'object' || Array.isArray(food)) {
      throw new Error('Related foods must be records');
    }
    const record = structuredClone(food);
    record.id = String(record.id || '').trim();
    if (!record.id || typeof record.name !== 'string' || !record.name.trim()) {
      throw new Error('Related foods require an ID and name');
    }
    return record;
  });
  const uniqueFoods = [...new Map(normalizedFoods.map(food => [food.id, food])).values()];
  if (idempotencyKeys != null
    && (!Array.isArray(idempotencyKeys) || idempotencyKeys.length !== validated.length)) {
    throw new Error('Meal batch idempotency keys must match the meal count');
  }
  const baseKey = idempotencyKeys ? null : normalizeIdempotencyKey(idempotencyKey);
  const commandKeys = idempotencyKeys
    ? idempotencyKeys.map(normalizeIdempotencyKey)
    : validated.map((_, index) => (
      validated.length === 1 ? baseKey : normalizeIdempotencyKey(`${baseKey}:${index}`)
    ));
  if (new Set(commandKeys).size !== commandKeys.length) {
    throw new Error('Meal batch idempotency keys must be unique');
  }
  const db = await openDB();
  const transaction = db.transaction(storesForLocalMutation(['foods', 'meals']), 'readwrite');
  const completion = waitForTransaction(transaction);
  const foodsStore = transaction.objectStore('foods');
  const mealsStore = transaction.objectStore('meals');
  try {
    const [existingMeals, existingFoods] = await Promise.all([
      Promise.all(commandKeys.map(commandKey => transactionRequest(
        mealsStore.index('idempotencyKey').get(commandKey),
      ))),
      Promise.all(uniqueFoods.map(food => transactionRequest(foodsStore.get(food.id)))),
    ]);
    const timestamp = now();
    const writtenFoods = [];
    if (existingMeals.some(meal => !meal)) {
      uniqueFoods.forEach((food, index) => {
        // Imported food definitions are dependencies. Never overwrite a
        // catalog record the user has already edited or deleted.
        if (existingFoods[index]) return;
        const record = {
          ...food,
          createdAt: food.createdAt || timestamp,
          updatedAt: timestamp,
          deleted: false,
        };
        foodsStore.put(record);
        writtenFoods.push(record);
      });
    }
    const results = validated.map((mealInput, index) => {
      const existing = existingMeals[index];
      // A command key identifies an already handled import/copy. A tombstone
      // is a deliberate deletion, not permission to revive it on retry.
      if (existing) return { meal: existing, created: false };
      const meal = {
        ...mealInput,
        id: uuid(),
        idempotencyKey: commandKeys[index],
        createdAt: mealInput.createdAt || timestamp,
        updatedAt: timestamp,
        deleted: false,
      };
      mealsStore.put(meal);
      return { meal, created: true };
    });
    const changes = [
      ...writtenFoods.map(record => toSyncChange('foods', record, 'put')),
      ...results
        .filter(result => result.created)
        .map(result => attachContext(toSyncChange('meals', result.meal, 'put'), context)),
    ].filter(Boolean);
    if (changes.length) await recordLibreLogChanges(transaction, changes);
    await completion;
    return results;
  } catch (error) {
    try { transaction.abort(); } catch { /* already closed */ }
    try { await completion; } catch { /* consume transaction failure */ }
    throw error;
  }
}

export async function createMealBatch(inputs, options = {}) {
  return withMaybeDataWriteLock(
    () => createMealBatchWithWriteLockHeld(inputs, options),
    options,
  );
}

export async function copyMealsToDate(meals, targetDate, options = {}) {
  if (!Array.isArray(meals)) throw new Error('Source meals must be an array');
  const copies = meals
    .filter(meal => Array.isArray(meal.items) && meal.items.length > 0)
    .map(meal => ({
      date: targetDate,
      type: meal.type,
      items: meal.items.map(item => structuredClone(item)),
    }));
  return createMealBatch(copies, options);
}
