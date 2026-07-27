import { getById, put, uuid } from './db.js';

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snacks']);

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
  for (const item of input.items) {
    if (!item || typeof item.foodId !== 'string' || !item.foodId) {
      throw new Error('Each meal item requires a food ID');
    }
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) {
      throw new Error('Each meal item requires a positive quantity');
    }
    if (typeof item.unit !== 'string' || !item.unit.trim()) {
      throw new Error('Each meal item requires a unit');
    }
  }
  return { ...input, type };
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
