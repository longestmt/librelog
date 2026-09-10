import { now, openDB } from './db.js';
import {
  recordLibreLogChanges,
  storesForLocalMutation,
  waitForTransaction,
} from '../sync/atomic.js';
import { toSyncChange } from '../sync/policy.js';
import {
  assertDataMutationGenerationCurrent,
  captureDataMutationGeneration,
  hasDataWriteLock,
  withDataWriteLock,
} from './operation-locks.js';

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
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

/** Patch only fields exposed by the measurement editor onto the freshest
 * record in the same domain/outbox transaction. A base record is retained for
 * the live side of a remote-delete-versus-stale-edit conflict. */
async function updateMeasurementWithWriteLockHeld(
  measurementId,
  patch,
  { context, baseRecord = null, database = openDB } = {},
) {
  if (!measurementId) throw new Error('Measurement ID is required');
  if (!isCalendarDate(patch?.date)
    || typeof patch.weight !== 'number' || !Number.isFinite(patch.weight) || patch.weight <= 0
    || !['kg', 'lb'].includes(patch.unit)
    || (patch.bodyFat != null
      && (typeof patch.bodyFat !== 'number' || !Number.isFinite(patch.bodyFat)
        || patch.bodyFat < 0 || patch.bodyFat > 100))) {
    throw new Error('Measurement update is malformed');
  }
  const db = typeof database === 'function' ? await database() : await database;
  const transaction = db.transaction(storesForLocalMutation(['measurements']), 'readwrite');
  const completion = waitForTransaction(transaction);
  try {
    const store = transaction.objectStore('measurements');
    const current = await request(store.get(measurementId));
    const source = current?.deleted === true ? baseRecord : current;
    if (!source) throw new Error('Measurement was not found');
    const record = {
      ...structuredClone(source),
      id: measurementId,
      date: patch.date,
      weight: patch.weight,
      unit: patch.unit,
      bodyFat: patch.bodyFat,
      updatedAt: now(),
      deleted: false,
    };
    store.put(record);
    const change = toSyncChange('measurements', record, 'put');
    if (context !== undefined) change.context = structuredClone(context);
    await recordLibreLogChanges(transaction, [change]);
    await completion;
    return record;
  } catch (error) {
    try { transaction.abort(); } catch { /* already closed */ }
    try { await completion; } catch { /* consume failure */ }
    throw error;
  }
}

export async function updateMeasurement(measurementId, patch, options = {}) {
  return withMaybeDataWriteLock(
    () => updateMeasurementWithWriteLockHeld(measurementId, patch, options),
    options,
  );
}
