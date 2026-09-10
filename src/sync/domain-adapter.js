import { assertRemoteEntity, SYNCED_DOMAIN_STORES } from './policy.js';

const remoteMutationNotifications = new WeakMap();

function notifyAfterCommit(transaction, source, projections) {
  const existing = remoteMutationNotifications.get(transaction);
  if (existing) {
    existing.sources.add(source);
    for (const projection of projections) {
      existing.entities.set(
        `${projection.entityType}\u0000${projection.entityId}`,
        { entityType: projection.entityType, entityId: projection.entityId },
      );
    }
    return;
  }

  const notification = {
    sources: new Set([source]),
    entities: new Map(projections.map(projection => [
      `${projection.entityType}\u0000${projection.entityId}`,
      { entityType: projection.entityType, entityId: projection.entityId },
    ])),
  };
  remoteMutationNotifications.set(transaction, notification);
  transaction.addEventListener('complete', () => {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    const committedSources = [...notification.sources].sort();
    const entities = [...notification.entities.values()].sort((left, right) => (
      left.entityType.localeCompare(right.entityType)
      || left.entityId.localeCompare(right.entityId)
    ));
    window.dispatchEvent(new CustomEvent('librelog:remote-mutation', {
      detail: {
        source: committedSources.length === 1 ? committedSources[0] : 'mixed',
        sources: committedSources,
        entities,
      },
    }));
  }, { once: true });
}

function requireRecord(payload, label) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Remote ${label} payload must be an object`);
  }
  return structuredClone(payload);
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function requireString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Remote ${label} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function validateOptionalString(value, label, maxLength) {
  if (value != null && (typeof value !== 'string' || value.length > maxLength)) {
    throw new Error(`Remote ${label} must be a string of at most ${maxLength} characters`);
  }
}

function requireFiniteNumber(value, label, { min = 0, max = 1_000_000_000 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Remote ${label} must be a finite number between ${min} and ${max}`);
  }
}

function validateNullableNutritionNumber(value, label) {
  if (value === null) return;
  requireFiniteNumber(value, label);
}

function validateServingSize(servingSize, label) {
  if (!servingSize || typeof servingSize !== 'object' || Array.isArray(servingSize)) {
    throw new Error(`Remote ${label} serving size is malformed`);
  }
  requireFiniteNumber(servingSize.quantity, `${label} serving quantity`, { min: Number.EPSILON });
  requireString(servingSize.unit, `${label} serving unit`, 80);
  if (servingSize.gramsPerUnit != null) {
    requireFiniteNumber(servingSize.gramsPerUnit, `${label} grams per unit`, { min: Number.EPSILON });
  }
  if (servingSize.aliases != null) {
    if (!Array.isArray(servingSize.aliases) || servingSize.aliases.length > 128) {
      throw new Error(`Remote ${label} serving aliases are malformed`);
    }
    for (const alias of servingSize.aliases) {
      if (!alias || typeof alias !== 'object' || Array.isArray(alias)) {
        throw new Error(`Remote ${label} serving alias is malformed`);
      }
      requireString(alias.unit, `${label} serving alias unit`, 80);
      requireFiniteNumber(alias.gramsPerUnit, `${label} serving alias grams`, { min: Number.EPSILON });
    }
  }
}

function validateCanonicalFoodNutrients(nutrients) {
  const requiredObjects = [
    nutrients?.energy,
    nutrients?.macros,
    nutrients?.macros?.protein,
    nutrients?.macros?.carbs,
    nutrients?.macros?.fat,
    nutrients?.fiber,
    nutrients?.sodium,
  ];
  if (requiredObjects.some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('Remote food nutrition structure is malformed');
  }
  for (const [value, label] of [
    [nutrients.energy.kcal, 'food calories'],
    [nutrients.macros.protein.g, 'food protein'],
    [nutrients.macros.carbs.g, 'food carbohydrates'],
    [nutrients.macros.fat.g, 'food fat'],
    [nutrients.fiber.g, 'food fiber'],
    [nutrients.sodium.mg, 'food sodium'],
  ]) validateNullableNutritionNumber(value, label);
}

function validateItemNutrients(nutrients) {
  if (!nutrients || typeof nutrients !== 'object' || Array.isArray(nutrients)) {
    throw new Error('Remote child nutrition is malformed');
  }
  for (const key of ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sodium']) {
    if (Object.hasOwn(nutrients, key)) validateNullableNutritionNumber(nutrients[key], `child ${key}`);
  }
}

function validateItems(items, { allowEmpty = false } = {}) {
  if (!Array.isArray(items) || items.length > 10_000 || (!allowEmpty && items.length === 0)) {
    throw new Error('Remote payload requires an item array');
  }
  const itemIds = new Set();
  for (const item of items) {
    if (typeof item?.itemId !== 'string' || !item.itemId
      || item.itemId.length > 256
      || typeof item.foodId !== 'string' || !item.foodId
      || item.foodId.length > 256
      || typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0
      || typeof item.unit !== 'string' || !item.unit.trim() || item.unit.length > 80) {
      throw new Error('Remote payload contains a malformed child item');
    }
    if (itemIds.has(item.itemId)) throw new Error('Remote payload contains duplicate child item IDs');
    itemIds.add(item.itemId);
    validateOptionalString(item.notes, 'child notes', 2000);
    if (item.mealType != null
      && !['breakfast', 'lunch', 'dinner', 'snacks'].includes(item.mealType)) {
      throw new Error('Remote template child has an invalid meal type');
    }
    if (item.nutrients != null) validateItemNutrients(item.nutrients);
  }
}

function validateSetting(record) {
  if (record.key === 'theme' && !['compline', 'vigil', 'lauds'].includes(record.value)) {
    throw new Error('Remote theme is unsupported');
  }
  if (record.key === 'unit' && !['metric', 'imperial'].includes(record.value)) {
    throw new Error('Remote unit is unsupported');
  }
  if (record.key === 'nutritionGoals') {
    const keys = ['calorieTarget', 'proteinG', 'carbG', 'fatG', 'fiberG', 'sodiumMg'];
    if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)
      || keys.some(key => typeof record.value[key] !== 'number'
        || !Number.isFinite(record.value[key])
        || record.value[key] < 0
        || record.value[key] > 1_000_000)) {
      throw new Error('Remote nutrition goals are malformed');
    }
  }
  if (record.key.startsWith('note_')
    && (typeof record.value !== 'string' || record.value.length > 2000)) {
    throw new Error('Remote note is malformed');
  }
  if (record.key.startsWith('template_')) {
    if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) {
      throw new Error('Remote template is malformed');
    }
    requireString(record.value.name, 'template name', 120);
    validateItems(record.value.items, { allowEmpty: true });
  }
}

function validateDomainRecord(entityType, record) {
  if (entityType === 'foods') {
    requireString(record.name, 'food name', 240);
    validateOptionalString(record.brand, 'food brand', 240);
    validateOptionalString(record.category, 'food category', 2000);
    validateServingSize(record.servingSize, 'food');
    if (!record.nutrients || typeof record.nutrients !== 'object' || Array.isArray(record.nutrients)) {
      throw new Error('Remote food nutrition is malformed');
    }
    validateCanonicalFoodNutrients(record.nutrients);
    if (record.usualServing != null) validateServingSize(record.usualServing, 'usual');
    if (record.favorite != null && typeof record.favorite !== 'boolean') {
      throw new Error('Remote food favorite flag is malformed');
    }
    if (record.source != null
      && (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)
        || typeof record.source.type !== 'string' || !record.source.type.trim()
        || record.source.type.length > 80)) {
      throw new Error('Remote food source is malformed');
    }
  } else if (entityType === 'meals') {
    if (!isCalendarDate(record.date) || !['breakfast', 'lunch', 'dinner', 'snacks'].includes(record.type)) {
      throw new Error('Remote meal is malformed');
    }
    validateItems(record.items);
  } else if (entityType === 'recipes') {
    requireString(record.name, 'recipe name', 240);
    validateItems(record.items, { allowEmpty: true });
    if (record.servings != null) {
      requireFiniteNumber(record.servings, 'recipe servings', { min: Number.EPSILON, max: 100_000 });
    }
    validateOptionalString(record.category, 'recipe category', 80);
    validateOptionalString(record.instructions, 'recipe instructions', 10_000);
    if (record.nutritionPerServing != null) {
      validateItemNutrients(record.nutritionPerServing);
      if (record.nutritionPerServing.incomplete != null) {
        const supportedNutrients = new Set(['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sodium']);
        const incomplete = record.nutritionPerServing.incomplete;
        if (!Array.isArray(incomplete)
          || incomplete.length > supportedNutrients.size
          || new Set(incomplete).size !== incomplete.length
          || incomplete.some(key => typeof key !== 'string' || !supportedNutrients.has(key))) {
          throw new Error('Remote recipe nutrition completeness list is malformed');
        }
      }
    }
  } else if (entityType === 'measurements') {
    if (!isCalendarDate(record.date) || typeof record.weight !== 'number'
      || !Number.isFinite(record.weight) || record.weight <= 0 || record.weight > 10_000
      || (record.unit != null && !['kg', 'lb'].includes(record.unit))) {
      throw new Error('Remote measurement payload is malformed');
    }
  } else if (entityType === 'settings') {
    validateSetting(record);
  }
}

function validateProjection(projection) {
  assertRemoteEntity(projection);
  if (projection.kind === 'delete') return projection;
  const record = requireRecord(projection.payload, projection.entityType);
  const identity = projection.entityType === 'settings' ? record.key : record.id;
  if (identity !== projection.entityId) {
    throw new Error('Remote payload identity does not match its encrypted entity metadata');
  }
  validateDomainRecord(projection.entityType, record);
  return { ...projection, payload: record };
}

function tombstone(entityType, entityId, authoredAt) {
  return entityType === 'settings'
    ? { key: entityId, value: null, deleted: true, updatedAt: authoredAt }
    : { id: entityId, deleted: true, updatedAt: authoredAt };
}

/**
 * Apply client-materialized projections directly to the app's existing
 * transaction. This deliberately bypasses db.put/setSetting, so a remote
 * operation can never create an outbox echo.
 */
export function applyLibreLogMaterialized({ transaction, entities, operation, source }) {
  if (!['remote', 'reconcile', 'resolution'].includes(source)) {
    throw new Error('LibreLog sync adapter received an unsupported source');
  }
  if (!transaction || !Array.isArray(entities)) throw new Error('Remote apply transaction is invalid');
  // Validate the full batch before issuing any request. The client can then
  // quarantine a rejected envelope in this same still-active transaction.
  const projections = entities.map(validateProjection);
  for (const projection of projections) {
    const store = transaction.objectStore(projection.entityType);
    const record = projection.kind === 'put'
      ? { ...projection.payload, deleted: false }
      : tombstone(projection.entityType, projection.entityId, operation.authoredAt);
    store.put(record);
  }
  if (projections.length) notifyAfterCommit(transaction, source, projections);
}

export function storesForRemoteOperation(operation) {
  if (!operation?.changes || !Array.isArray(operation.changes)) return [];
  return [...new Set(operation.changes.map(change => change.entityType))]
    .filter(storeName => SYNCED_DOMAIN_STORES.includes(storeName));
}
