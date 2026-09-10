import { newId } from './identity.js';
import { now, openDB } from './db.js';
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

function request(value) {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

/** Persist a recipe and any newly discovered ingredient foods as one domain
 * transaction and one causal multi-entity operation. */
async function saveRecipeWithFoodsWithWriteLockHeld(
  recipe,
  relatedFoods = [],
  { context, database = openDB } = {},
) {
  if (!recipe || typeof recipe !== 'object' || typeof recipe.name !== 'string' || !recipe.name.trim()) {
    throw new Error('Recipe requires a name');
  }
  if (!Array.isArray(recipe.items) || !recipe.items.length) {
    throw new Error('Recipe requires at least one ingredient');
  }
  const db = typeof database === 'function' ? await database() : await database;
  const transaction = db.transaction(
    storesForLocalMutation(['foods', 'recipes']),
    'readwrite',
  );
  const completion = waitForTransaction(transaction);
  const foodsStore = transaction.objectStore('foods');
  const recipesStore = transaction.objectStore('recipes');
  const timestamp = now();

  try {
    const existingFoods = await Promise.all(relatedFoods.map(food => (
      request(foodsStore.get(food.id))
    )));
    const existingRecipe = recipe.id ? await request(recipesStore.get(recipe.id)) : null;
    const newFoods = [];
    relatedFoods.forEach((food, index) => {
      if (existingFoods[index]) return;
      const record = {
        ...structuredClone(food),
        id: food.id || newId(),
        createdAt: food.createdAt || timestamp,
        updatedAt: timestamp,
        deleted: false,
      };
      foodsStore.put(record);
      newFoods.push(record);
    });
    const storedRecipe = {
      ...(existingRecipe || {}),
      ...structuredClone(recipe),
      id: recipe.id || newId(),
      createdAt: recipe.createdAt || timestamp,
      updatedAt: timestamp,
      deleted: false,
    };
    recipesStore.put(storedRecipe);
    const recipeChange = toSyncChange('recipes', storedRecipe, 'put');
    if (context !== undefined) recipeChange.context = structuredClone(context);
    const changes = [
      ...newFoods.map(food => toSyncChange('foods', food, 'put')),
      recipeChange,
    ].filter(Boolean);
    await recordLibreLogChanges(transaction, changes);
    await completion;
    return storedRecipe;
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction already failed */ }
    try { await completion; } catch { /* consume transaction failure */ }
    throw error;
  }
}

export async function saveRecipeWithFoods(recipe, relatedFoods = [], options = {}) {
  return withMaybeDataWriteLock(
    () => saveRecipeWithFoodsWithWriteLockHeld(recipe, relatedFoods, options),
    options,
  );
}

async function deleteRecipeWithWriteLockHeld(
  recipeId,
  { context, database = openDB } = {},
) {
  if (typeof recipeId !== 'string' || !recipeId) throw new Error('Recipe ID is required');
  const db = typeof database === 'function' ? await database() : await database;
  const transaction = db.transaction(storesForLocalMutation(['recipes']), 'readwrite');
  const completion = waitForTransaction(transaction);
  try {
    const store = transaction.objectStore('recipes');
    const existing = await request(store.get(recipeId));
    if (!existing || existing.deleted === true) {
      await completion;
      return false;
    }
    const record = { ...existing, deleted: true, updatedAt: now() };
    store.put(record);
    const change = toSyncChange('recipes', record, 'delete');
    if (context !== undefined) change.context = structuredClone(context);
    await recordLibreLogChanges(transaction, [change]);
    await completion;
    return true;
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction already failed */ }
    try { await completion; } catch { /* consume transaction failure */ }
    throw error;
  }
}

export async function deleteRecipe(recipeId, options = {}) {
  return withMaybeDataWriteLock(
    () => deleteRecipeWithWriteLockHeld(recipeId, options),
    options,
  );
}
