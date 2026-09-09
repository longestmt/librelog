/**
 * Local-only state for the Add workspace.
 *
 * The unfinished draft deliberately lives outside IndexedDB so it is not
 * included in backup or sync exports. Nutrition is always recalculated from
 * an immutable basis snapshot; changing the consumed quantity never mutates
 * the reference serving returned by a database or AI provider.
 */

import {
  assertDataMutationGenerationCurrent,
  captureDataMutationGeneration,
  getDataLockManager,
  hasDataDestructiveLock,
  hasDataMutationGuard,
  withDataMutationGuard,
} from './operation-locks.js';

export const ADD_DRAFT_STORAGE_KEY = 'librelog_add_draft_v1';
export const ADD_DRAFT_VERSION = 1;
export const ADD_DRAFT_LOCK_NAME = 'librelog:add-draft:v1';
const activeDraftLockTokens = new WeakSet();
const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snacks']);
const NUTRIENT_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sodium'];

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createLocalId(prefix) {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  return `${prefix}:${random}`;
}

function getBrowserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function normalizeMealType(value) {
  const mealType = String(value || '').toLowerCase();
  return MEAL_TYPES.has(mealType) ? mealType : 'lunch';
}

function validDraftItem(item) {
  return item
    && typeof item === 'object'
    && typeof item.draftItemId === 'string'
    && item.draftItemId.length > 0
    && typeof item.foodId === 'string'
    && item.foodId.length > 0
    && typeof item.nameSnapshot === 'string'
    && Number.isFinite(Number(item.quantity))
    && Number(item.quantity) > 0
    && typeof item.unit === 'string'
    && item.unit.length > 0
    && item.basisSnapshot
    && Number.isFinite(Number(item.basisSnapshot.quantity))
    && Number(item.basisSnapshot.quantity) > 0
    && typeof item.basisSnapshot.unit === 'string'
    && item.basisSnapshot.unit.length > 0
    && item.basisSnapshot.nutrients
    && typeof item.basisSnapshot.nutrients === 'object'
    && item.nutrients
    && typeof item.nutrients === 'object';
}

function nutritionFromFood(food) {
  return {
    kcal: numberOrNull(food?.nutrients?.energy?.kcal),
    protein: numberOrNull(food?.nutrients?.macros?.protein?.g),
    carbs: numberOrNull(food?.nutrients?.macros?.carbs?.g),
    fat: numberOrNull(food?.nutrients?.macros?.fat?.g),
    fiber: numberOrNull(food?.nutrients?.fiber?.g),
    sodium: numberOrNull(food?.nutrients?.sodium?.mg),
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}

function scaledValue(value, multiplier, precision) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  return Math.round(value * multiplier * factor) / factor;
}

function explicitGramsPerUnit(basis, unit) {
  if (unit === basis.unit && Number.isFinite(basis.gramsPerUnit)) {
    return basis.gramsPerUnit;
  }
  const alias = basis.aliases?.find(candidate => candidate.unit === unit);
  return Number.isFinite(alias?.gramsPerUnit) ? alias.gramsPerUnit : null;
}

const GRAMS_PER_UNIT = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
  ml: 1,
  l: 1000,
  cup: 240,
  tbsp: 15,
  tsp: 5,
  fl_oz: 29.5735,
};

function quantityInGrams(quantity, unit, basis) {
  const explicit = explicitGramsPerUnit(basis, unit);
  if (explicit != null) return quantity * explicit;
  const standard = GRAMS_PER_UNIT[unit];
  return standard == null ? null : quantity * standard;
}

/** Return a safe blank draft for a destination. */
export function createAddDraft({ date, mealType = 'lunch' } = {}) {
  return {
    version: ADD_DRAFT_VERSION,
    id: createLocalId('draft'),
    idempotencyKey: createLocalId('add'),
    revision: 0,
    date: validDate(date) ? date : new Date().toISOString().slice(0, 10),
    mealType: normalizeMealType(mealType),
    items: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Restore a draft. Invalid or obsolete local state is ignored. Use
 * loadAddDraftForDestination when a route may retarget an existing empty draft.
 */
export function loadAddDraft({ storage, date, mealType } = {}) {
  const resolvedStorage = storage === undefined ? getBrowserStorage() : storage;
  let restored = null;
  let storedValue = null;
  try {
    storedValue = resolvedStorage?.getItem(ADD_DRAFT_STORAGE_KEY) || null;
    const parsed = JSON.parse(storedValue || 'null');
    if (parsed?.version === ADD_DRAFT_VERSION
      && typeof parsed.id === 'string'
      && parsed.id.length > 0
      && typeof parsed.idempotencyKey === 'string'
      && /^[a-zA-Z0-9._:-]{8,160}$/.test(parsed.idempotencyKey)
      && Number.isInteger(Number(parsed.revision))
      && Number(parsed.revision) >= 0
      && validDate(parsed.date)
      && MEAL_TYPES.has(parsed.mealType)
      && Array.isArray(parsed.items)
      && parsed.items.every(validDraftItem)) {
      restored = parsed;
    } else if (storedValue != null) {
      resolvedStorage?.removeItem(ADD_DRAFT_STORAGE_KEY);
    }
  } catch {
    // Corrupt local UI state must never stop food logging.
    try { resolvedStorage?.removeItem(ADD_DRAFT_STORAGE_KEY); } catch {}
  }

  return restored ? clone(restored) : createAddDraft({ date, mealType });
}

/**
 * Restore a draft and atomically retarget an empty persisted draft. This keeps
 * its in-memory revision byte-identical to storage for the next compare/write.
 */
export async function loadAddDraftForDestination({
  storage,
  date,
  mealType,
  lockManager,
  mutationGeneration,
} = {}) {
  return withAddDraftLock(() => {
    const draft = loadAddDraft({ storage, date, mealType });
    if (draft.items.length > 0) return draft;
    const nextDate = validDate(date) ? date : draft.date;
    const nextMealType = normalizeMealType(mealType || draft.mealType);
    if (draft.date === nextDate && draft.mealType === nextMealType) return draft;
    return saveAddDraft({ ...draft, date: nextDate, mealType: nextMealType }, storage);
  }, lockManager, { mutationGeneration });
}

export function saveAddDraft(draft, storage) {
  const resolvedStorage = storage === undefined ? getBrowserStorage() : storage;
  if (!resolvedStorage) throw new Error('Draft storage is not available');
  const next = {
    ...clone(draft),
    version: ADD_DRAFT_VERSION,
    revision: Number(draft?.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  resolvedStorage?.setItem(ADD_DRAFT_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Serialize draft compare-and-write operations across same-origin tabs. */
export async function withAddDraftLock(
  operation,
  lockManager = globalThis.navigator?.locks,
  {
    destructiveLockToken,
    mutationGuardToken,
    mutationGeneration = captureDataMutationGeneration(),
  } = {},
) {
  if (typeof operation !== 'function') throw new TypeError('A draft operation is required');
  const acquireDraftLock = async guardToken => {
    const run = async () => {
      const token = {};
      activeDraftLockTokens.add(token);
      try {
        assertDataMutationGenerationCurrent(mutationGeneration);
        return await operation(token, guardToken);
      } finally {
        activeDraftLockTokens.delete(token);
      }
    };
    return getDataLockManager(lockManager)
      .request(ADD_DRAFT_LOCK_NAME, { mode: 'exclusive' }, run);
  };
  if (hasDataDestructiveLock(destructiveLockToken)) return acquireDraftLock(null);
  if (hasDataMutationGuard(mutationGuardToken)) return acquireDraftLock(mutationGuardToken);
  return withDataMutationGuard(
    guardToken => acquireDraftLock(guardToken),
    lockManager,
  );
}

export function hasAddDraftLock(token) {
  return token != null && typeof token === 'object' && activeDraftLockTokens.has(token);
}

export async function saveAddDraftIfCurrent(currentDraft, nextDraft, {
  storage,
  lockManager,
  mutationGeneration,
} = {}) {
  return withAddDraftLock(() => {
    if (!isAddDraftCurrent(currentDraft, storage)) return null;
    return saveAddDraft(nextDraft, storage);
  }, lockManager, { mutationGeneration });
}

export async function clearAddDraftIfCurrentLocked(draft, {
  storage,
  lockManager,
  mutationGeneration,
} = {}) {
  return withAddDraftLock(
    () => clearAddDraftIfCurrent(draft, storage),
    lockManager,
    { mutationGeneration },
  );
}

export function clearAddDraft(storage) {
  try {
    const resolvedStorage = storage === undefined ? getBrowserStorage() : storage;
    resolvedStorage?.removeItem(ADD_DRAFT_STORAGE_KEY);
    return true;
  } catch {
    // A meal save has already committed by the time draft cleanup runs. A
    // blocked browser storage API must not turn that success into a false
    // failure or make the command look safe to replay.
    return false;
  }
}

/**
 * Return false when another tab has replaced or cleared a persisted draft.
 * Unavailable storage is not itself a conflict; callers can still perform an
 * explicitly reviewed in-memory save and rely on its idempotency key.
 */
export function isAddDraftCurrent(draft, storage) {
  const resolvedStorage = storage === undefined ? getBrowserStorage() : storage;
  if (!resolvedStorage) return true;
  try {
    const raw = resolvedStorage.getItem(ADD_DRAFT_STORAGE_KEY);
    if (raw == null) return Number(draft?.revision || 0) === 0;
    return raw === JSON.stringify(draft);
  } catch {
    return true;
  }
}

/** Clear only the exact draft that was reviewed and committed. */
export function clearAddDraftIfCurrent(draft, storage) {
  const resolvedStorage = storage === undefined ? getBrowserStorage() : storage;
  if (!resolvedStorage) return false;
  try {
    const raw = resolvedStorage.getItem(ADD_DRAFT_STORAGE_KEY);
    if (raw == null) return Number(draft?.revision || 0) === 0;
    if (raw !== JSON.stringify(draft)) return false;
    resolvedStorage.removeItem(ADD_DRAFT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Restore an undone draft only when it cannot overwrite another draft. */
export function restoreAddDraftIfVacant(draft, storage) {
  const resolvedStorage = storage === undefined ? getBrowserStorage() : storage;
  if (!resolvedStorage) return null;
  try {
    const raw = resolvedStorage.getItem(ADD_DRAFT_STORAGE_KEY);
    if (raw != null && raw !== JSON.stringify(draft)) return null;
    return saveAddDraft(draft, resolvedStorage);
  } catch {
    return null;
  }
}

function getDraftMultiplier(item) {
  const basis = item?.basisSnapshot;
  const quantity = Number(item?.quantity);
  if (!basis || !Number.isFinite(quantity) || quantity <= 0) {
    return NaN;
  }

  if (item.unit === basis.unit) {
    return quantity / basis.quantity;
  }
  const consumedGrams = quantityInGrams(quantity, item.unit, basis);
  const basisGrams = quantityInGrams(basis.quantity, basis.unit, basis);
  return consumedGrams == null || !basisGrams ? NaN : consumedGrams / basisGrams;
}

export function getDraftNutrition(item) {
  const basis = item?.basisSnapshot;
  const multiplier = getDraftMultiplier(item);

  if (!Number.isFinite(multiplier)) {
    return Object.fromEntries(NUTRIENT_KEYS.map(key => [key, null]));
  }
  const nutrients = basis.nutrients || {};
  return {
    kcal: scaledValue(nutrients.kcal, multiplier, 1),
    protein: scaledValue(nutrients.protein, multiplier, 2),
    carbs: scaledValue(nutrients.carbs, multiplier, 2),
    fat: scaledValue(nutrients.fat, multiplier, 2),
    fiber: scaledValue(nutrients.fiber, multiplier, 2),
    sodium: scaledValue(nutrients.sodium, multiplier, 1),
  };
}

function normalizedSource(food) {
  const source = food?.source?.type || 'local';
  if (source === 'openFoodFacts') return 'Open Food Facts';
  if (source === 'usda') return 'USDA';
  if (source === 'custom') return 'My food';
  if (source === 'recipe') return 'Recipe';
  if (String(source).startsWith('ai-') || food?._aiMeta?.estimated) return 'AI estimate';
  return 'Saved food';
}

function stableHash(value) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableFoodId(food, basis, assumptions) {
  const aiEstimate = food?._aiMeta?.estimated || String(food?.source?.type || '').startsWith('ai-');
  if (food?.id && !aiEstimate) return food.id;
  return `draft-food:${stableHash({
    name: String(food?.name || '').trim().toLowerCase(),
    brand: String(food?.brand || '').trim().toLowerCase(),
    source: food?.source?.type || 'local',
    basis,
    assumptions: clone(assumptions || []),
  })}`;
}

/** Convert any conventional, scanned, custom, or AI food into one draft item. */
export function createDraftItem(food, options = {}) {
  const servingSize = food?.servingSize || { quantity: 100, unit: 'g' };
  const basis = {
    quantity: Number(servingSize.quantity) > 0 ? Number(servingSize.quantity) : 100,
    unit: servingSize.unit || 'g',
    gramsPerUnit: numberOrNull(servingSize.gramsPerUnit),
    aliases: clone(servingSize.aliases || []),
    label: servingSize.label || null,
    packageQuantity: numberOrNull(servingSize.packageQuantity),
    packageUnit: servingSize.packageUnit || null,
    preparation: servingSize.preparation || food?.preparation || null,
    nutrients: nutritionFromFood(food),
  };
  const quantity = Number(options.quantity) > 0 ? Number(options.quantity) : basis.quantity;
  const unit = options.unit || basis.unit;
  const assumptions = options.assumptions || food?._aiMeta?.assumptions || [];
  const foodId = stableFoodId(food, basis, assumptions);
  const foodSnapshot = {
    ...clone(food),
    id: foodId,
    name: String(options.name || food?.name || 'Food'),
    servingSize: clone(servingSize),
  };
  delete foodSnapshot._draftQuantity;
  delete foodSnapshot._draftUnit;
  delete foodSnapshot._aiOriginalBasis;
  const item = {
    draftItemId: options.draftItemId || createLocalId('item'),
    foodId,
    nameSnapshot: String(options.name || food?.name || 'Food'),
    brandSnapshot: food?.brand || '',
    quantity,
    unit,
    notes: options.notes || '',
    basisSnapshot: basis,
    provenance: {
      nutritionSource: options.nutritionSource || normalizedSource(food),
      inputMethod: options.inputMethod || 'searched',
      sourceId: food?.source?.id || food?.barcode || null,
      assumptions: clone(assumptions),
      adjusted: Boolean(options.adjusted),
      providerBasis: clone(options.providerBasis || food?._aiOriginalBasis || null),
    },
    ...(options.catalogPreferences ? { catalogPreferences: clone(options.catalogPreferences) } : {}),
    foodSnapshot,
  };
  item.nutrients = getDraftNutrition(item);
  return item;
}

/**
 * Apply a user's nutrient corrections to the currently displayed portion.
 * The provider serving remains the calculation basis, so the entered totals
 * are inverted exactly once and later portion changes continue to scale.
 */
export function rebaseFoodNutritionForPortion(food, { quantity, unit, nutrients }) {
  const item = createDraftItem(food, { quantity, unit });
  const multiplier = getDraftMultiplier(item);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError('This unit cannot be converted to the nutrition basis');
  }
  const next = clone(food);
  next._aiOriginalBasis = clone(food?._aiOriginalBasis || {
    servingSize: food?.servingSize,
    nutrients: nutritionFromFood(food),
  });
  const basis = nutritionFromFood(next);
  for (const [key, value] of Object.entries(nutrients || {})) {
    const currentPortionValue = numberOrNull(value);
    if (Object.hasOwn(basis, key)) {
      basis[key] = Number.isFinite(currentPortionValue) ? currentPortionValue / multiplier : null;
    }
  }
  next.nutrients = {
    ...(next.nutrients || {}),
    energy: { ...(next.nutrients?.energy || {}), kcal: basis.kcal },
    macros: {
      ...(next.nutrients?.macros || {}),
      protein: { ...(next.nutrients?.macros?.protein || {}), g: basis.protein },
      carbs: { ...(next.nutrients?.macros?.carbs || {}), g: basis.carbs },
      fat: { ...(next.nutrients?.macros?.fat || {}), g: basis.fat },
    },
    fiber: { ...(next.nutrients?.fiber || {}), g: basis.fiber },
    sodium: { ...(next.nutrients?.sodium || {}), mg: basis.sodium },
  };
  return next;
}

/** Reuse a historical/template item without changing its snapshotted totals. */
export function createDraftItemFromMealItem(mealItem, food, options = {}) {
  const quantity = Number(mealItem?.quantity) > 0 ? Number(mealItem.quantity) : 1;
  const unit = mealItem?.unit || food?.servingSize?.unit || 'serving';
  const nutrients = Object.fromEntries(NUTRIENT_KEYS.map(key => [key, numberOrNull(mealItem?.nutrients?.[key])]));
  const historicalBasis = mealItem?.basisSnapshot;
  const basisNutrients = historicalBasis?.nutrients || nutrients;
  const historicalName = mealItem?.nameSnapshot || food?.name || 'Saved item';
  const historicalBrand = mealItem?.brandSnapshot || food?.brand || '';
  const servingSize = historicalBasis
    ? {
        quantity: historicalBasis.quantity,
        unit: historicalBasis.unit,
        gramsPerUnit: numberOrNull(historicalBasis.gramsPerUnit),
        aliases: clone(historicalBasis.aliases || []),
        label: historicalBasis.label || null,
        packageQuantity: numberOrNull(historicalBasis.packageQuantity),
        packageUnit: historicalBasis.packageUnit || null,
        preparation: historicalBasis.preparation || null,
      }
    : { quantity, unit, aliases: [] };
  const basisFood = {
    ...clone(food || {}),
    id: mealItem.foodId || food?.id,
    name: historicalName,
    brand: historicalBrand,
    servingSize,
    nutrients: {
      energy: { kcal: numberOrNull(basisNutrients.kcal) },
      macros: {
        protein: { g: numberOrNull(basisNutrients.protein) },
        carbs: { g: numberOrNull(basisNutrients.carbs) },
        fat: { g: numberOrNull(basisNutrients.fat) },
      },
      fiber: { g: numberOrNull(basisNutrients.fiber) },
      sodium: { mg: numberOrNull(basisNutrients.sodium) },
    },
    source: food?.source || { type: 'local' },
  };
  return createDraftItem(basisFood, {
    quantity,
    unit,
    notes: mealItem.notes || '',
    inputMethod: options.inputMethod || 'familiar meal',
    nutritionSource: options.nutritionSource || 'Saved meal',
  });
}

export function updateDraftItem(item, updates) {
  const next = {
    ...clone(item),
    ...clone(updates),
    provenance: {
      ...(clone(item.provenance) || {}),
      adjusted: true,
    },
  };
  next.quantity = Number(next.quantity);
  if (!Number.isFinite(next.quantity) || next.quantity <= 0) {
    throw new RangeError('Quantity must be greater than zero');
  }
  const multiplier = getDraftMultiplier(next);
  if (!Number.isFinite(multiplier)) {
    throw new RangeError('The selected unit is not compatible with this serving');
  }
  next.nutrients = getDraftNutrition(next);
  return next;
}

export function getDraftTotals(draft) {
  const totals = Object.fromEntries(NUTRIENT_KEYS.map(key => [key, 0]));
  const incomplete = new Set();
  for (const item of draft?.items || []) {
    for (const key of NUTRIENT_KEYS) {
      if (Number.isFinite(item?.nutrients?.[key])) totals[key] += item.nutrients[key];
      else incomplete.add(key);
    }
  }
  totals.kcal = Math.round(totals.kcal);
  for (const key of ['protein', 'carbs', 'fat', 'fiber']) {
    totals[key] = Math.round(totals[key] * 10) / 10;
  }
  totals.sodium = Math.round(totals.sodium);
  totals.incomplete = [...incomplete];
  return totals;
}

/** Strip UI-only data before storing an item in a meal record. */
export function toMealItem(item) {
  return {
    foodId: item.foodId,
    nameSnapshot: item.nameSnapshot,
    brandSnapshot: item.brandSnapshot || '',
    quantity: item.quantity,
    unit: item.unit,
    notes: item.notes || '',
    nutrients: clone(item.nutrients),
    basisSnapshot: clone(item.basisSnapshot),
    provenance: clone(item.provenance),
  };
}
