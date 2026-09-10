import {
  ALL_SYNC_STORE_NAMES,
  SYNC_STORE_NAMES,
  installLibreSyncStores,
  recordLocalOperationWithProjection,
  requestToPromise,
  waitForTransaction,
} from '@libresync/client';
import { newId } from '../data/identity.js';
import { applyLibreLogMaterialized } from './domain-adapter.js';
import {
  LIBRELOG_APP_SCHEMA_VERSION,
} from './policy.js';
import { chunkLocalChanges } from './batching.js';

const DEVICE_ID_KEY = 'librelog:deviceId';
const DEVICE_ID_SETTING_KEY = 'libresync_deviceId';
const CONNECTION_STATE_KEY = 'connection';
const mutationNotifications = new WeakSet();

export {
  ALL_SYNC_STORE_NAMES,
  SYNC_STORE_NAMES,
  installLibreSyncStores,
  waitForTransaction,
};

async function deviceIdInTransaction(transaction) {
  const state = transaction.objectStore(SYNC_STORE_NAMES.state);
  const settings = transaction.objectStore('settings');
  const [connection, durable, legacy] = await Promise.all([
    requestToPromise(state.get(CONNECTION_STATE_KEY)),
    requestToPromise(settings.get(DEVICE_ID_SETTING_KEY)),
    requestToPromise(state.get(DEVICE_ID_KEY)),
  ]);
  // The authenticated connection wins when upgrading an installation that
  // encountered an older split-identity bug. Otherwise the local-only app
  // setting survives core disconnect(), which intentionally clears sync state.
  const deviceId = [connection?.value?.deviceId, durable?.value, legacy?.value]
    .find(value => typeof value === 'string' && value) || newId();
  if (legacy?.value !== deviceId) {
    await requestToPromise(state.put({ key: DEVICE_ID_KEY, value: deviceId }));
  }
  if (durable?.value !== deviceId) {
    await requestToPromise(settings.put({
      key: DEVICE_ID_SETTING_KEY,
      value: deviceId,
      updatedAt: new Date().toISOString(),
    }));
  }
  return deviceId;
}

export async function getOrCreateSyncDeviceId(database) {
  const transaction = database.transaction(['settings', SYNC_STORE_NAMES.state], 'readwrite');
  const completion = waitForTransaction(transaction);
  const deviceId = await deviceIdInTransaction(transaction);
  await completion;
  return deviceId;
}

/**
 * A disconnect ends one registered server device identity. Rotate before the
 * next pairing so the relay never sees a duplicate device ID, while keeping
 * the replacement stable across reloads and outside portable backups.
 */
export async function rotateSyncDeviceId(database) {
  const transaction = database.transaction(['settings', SYNC_STORE_NAMES.state], 'readwrite');
  const completion = waitForTransaction(transaction);
  const deviceId = newId();
  transaction.objectStore('settings').put({
    key: DEVICE_ID_SETTING_KEY,
    value: deviceId,
    updatedAt: new Date().toISOString(),
  });
  transaction.objectStore(SYNC_STORE_NAMES.state).put({ key: DEVICE_ID_KEY, value: deviceId });
  await completion;
  return deviceId;
}

export function storesForLocalMutation(domainStores) {
  // settings holds only the stable, local-only device identifier used by the
  // recorder. Including it keeps identity selection in the domain transaction.
  return [...new Set([...domainStores, 'settings', ...ALL_SYNC_STORE_NAMES])];
}

function notifyAfterCommit(transaction) {
  if (mutationNotifications.has(transaction)) return;
  mutationNotifications.add(transaction);
  transaction.addEventListener('complete', () => {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('librelog:local-mutation'));
  }, { once: true });
}

/** Record bounded operations without splitting the caller's domain transaction. */
export async function recordLibreLogChanges(transaction, changes) {
  if (!changes.length) return [];
  const connection = await requestToPromise(
    transaction.objectStore(SYNC_STORE_NAMES.state).get(CONNECTION_STATE_KEY),
  );
  if (!connection?.value) return [];
  notifyAfterCommit(transaction);
  const deviceId = await deviceIdInTransaction(transaction);
  const operations = [];
  for (const chunk of chunkLocalChanges(changes)) {
    const result = await recordLocalOperationWithProjection({
      transaction,
      deviceId,
      appSchemaVersion: LIBRELOG_APP_SCHEMA_VERSION,
      changes: chunk,
    });
    operations.push(result.operation);

    // An ordinary edit does not silently dominate unreviewed alternatives.
    // Reinstall the protocol's deterministic projection when a conflict remains.
    const conflicted = result.projections.filter(projection => projection.conflicted);
    if (conflicted.length) {
      applyLibreLogMaterialized({
        transaction,
        entities: conflicted,
        operation: result.operation,
        source: 'reconcile',
      });
    }
  }
  return operations;
}
