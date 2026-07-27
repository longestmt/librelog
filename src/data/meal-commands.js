import { getById, now, openDB, put, uuid } from './db.js';

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snacks']);
const MAX_APPLIED_COMMAND_KEYS = 20;

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
  return structuredClone(item);
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
  return { ...input, type, items: input.items.map(validateMealItem) };
}

/**
 * Create one meal record. A repeated command with the same key returns the
 * first record and does not create a second record.
 */
export async function createMeal(input, { idempotencyKey } = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const id = `meal:${key}`;
  const existing = await getById('meals', id);
  if (existing) return { meal: existing, created: false };

  const meal = await put('meals', {
    ...validateMealInput(input),
    id,
    idempotencyKey: key,
  });
  return { meal, created: true };
}

function transactionRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function mutateMeal(mealId, idempotencyKey, mutation) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const db = await openDB();
  const transaction = db.transaction('meals', 'readwrite');
  const store = transaction.objectStore('meals');
  const meal = await transactionRequest(store.get(mealId));

  if (!meal) {
    transaction.abort();
    throw new Error('Meal was not found');
  }
  if (meal.appliedCommandKeys?.includes(key)) {
    return { meal, changed: false };
  }
  if (meal.deleted) {
    transaction.abort();
    throw new Error('Meal was not found');
  }

  const next = mutation(structuredClone(meal));
  const appliedCommandKeys = [...(meal.appliedCommandKeys || []), key]
    .slice(-MAX_APPLIED_COMMAND_KEYS);
  const record = {
    ...next,
    appliedCommandKeys,
    updatedAt: now(),
  };
  store.put(record);

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Meal command failed'));
    transaction.onabort = () => reject(transaction.error || new Error('Meal command was aborted'));
  });
  return { meal: record, changed: true };
}

export async function updateMealItem(mealId, itemIndex, item, { idempotencyKey } = {}) {
  const index = Number(itemIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error('Meal item index is invalid');
  const validatedItem = validateMealItem(item);
  return mutateMeal(mealId, idempotencyKey, meal => {
    if (!Array.isArray(meal.items) || !meal.items[index]) {
      throw new Error('Meal item was not found');
    }
    meal.items[index] = validatedItem;
    return meal;
  });
}

export async function removeMealItem(mealId, itemIndex, { idempotencyKey } = {}) {
  const index = Number(itemIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error('Meal item index is invalid');
  return mutateMeal(mealId, idempotencyKey, meal => {
    if (!Array.isArray(meal.items) || !meal.items[index]) {
      throw new Error('Meal item was not found');
    }
    meal.items.splice(index, 1);
    if (meal.items.length === 0) meal.deleted = true;
    return meal;
  });
}

export async function createMealBatch(inputs, { idempotencyKey } = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const results = [];
  for (let index = 0; index < inputs.length; index += 1) {
    results.push(await createMeal(inputs[index], {
      idempotencyKey: `${key}:${index}`,
    }));
  }
  return results;
}

export async function copyMealsToDate(meals, targetDate, { idempotencyKey } = {}) {
  if (!Array.isArray(meals)) throw new Error('Source meals must be an array');
  const copies = meals
    .filter(meal => Array.isArray(meal.items) && meal.items.length > 0)
    .map(meal => ({
      date: targetDate,
      type: meal.type,
      items: meal.items.map(item => structuredClone(item)),
    }));
  return createMealBatch(copies, { idempotencyKey });
}
