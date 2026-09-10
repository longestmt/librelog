export const LIBRELOG_APP_ID = 'org.libresuite.librelog';
export const LIBRELOG_APP_SCHEMA_VERSION = 1;

export const SYNCED_DOMAIN_STORES = Object.freeze([
  'foods',
  'meals',
  'recipes',
  'measurements',
  'settings',
]);

const SYNCED_SETTING_KEYS = new Set([
  'nutritionGoals',
  'theme',
  'unit',
]);

export function isSyncedSettingKey(key) {
  return SYNCED_SETTING_KEYS.has(key)
    || (typeof key === 'string' && (key.startsWith('note_') || key.startsWith('template_')));
}

export function isSynchronizedEntity(storeName, entityId) {
  if (!SYNCED_DOMAIN_STORES.includes(storeName)) return false;
  return storeName !== 'settings' || isSyncedSettingKey(entityId);
}

export function entityIdForRecord(storeName, record) {
  return storeName === 'settings' ? record?.key : record?.id;
}

function synchronizedPayload(storeName, record) {
  const payload = structuredClone(record);
  delete payload.deleted;
  // Setting timestamps and installation-local seed timestamps are storage
  // metadata, not user-authored values. Omitting them lets independently
  // initialized profiles adopt identical defaults without false conflicts.
  if (storeName === 'settings') delete payload.updatedAt;
  if (storeName === 'foods' && payload?.source?.type === 'seed') {
    delete payload.createdAt;
    delete payload.updatedAt;
  }
  return payload;
}

export function toSyncChange(storeName, record, kind = 'put') {
  const entityId = entityIdForRecord(storeName, record);
  if (!isSynchronizedEntity(storeName, entityId)) return null;
  const change = { entityType: storeName, entityId, kind };
  if (kind === 'put') change.payload = synchronizedPayload(storeName, record);
  return change;
}

export function assertRemoteEntity(entity) {
  if (!entity || !isSynchronizedEntity(entity.entityType, entity.entityId)) {
    throw new Error('Remote operation targets a local-only or unknown LibreLog entity');
  }
  if (!['put', 'delete'].includes(entity.kind)) {
    throw new Error('Remote operation has an unsupported entity kind');
  }
  return entity;
}
