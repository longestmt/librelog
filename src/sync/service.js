import {
  createIndexedDbMutexLease,
  HttpSyncTransport,
  IndexedDbSecretStorage,
  LibreSyncClient,
  SyncMutex,
  SYNC_STORE_NAMES,
  mutexLeaseStateKey,
  requestToPromise,
  waitForTransaction,
} from '@libresync/client';
import {
  deleteAllSynchronizedData,
  openDB,
} from '../data/db.js';
import {
  clearAllDataAndBackups,
  stopAutoBackup,
} from '../data/auto-backup.js';
import { createPortableSafetyBackup } from '../data/portable-safety-backup.js';
import { applyLibreLogMaterialized } from './domain-adapter.js';
import { getOrCreateSyncDeviceId, rotateSyncDeviceId } from './atomic.js';
import { readLibreLogLocalEntities } from './local-entities.js';
import {
  LIBRELOG_APP_ID,
  LIBRELOG_APP_SCHEMA_VERSION,
  SYNCED_DOMAIN_STORES,
} from './policy.js';

const PREFERENCE_KEYS = Object.freeze({
  consent: 'librelog:remoteDataConsent',
  serverUrl: 'librelog:serverUrl',
  deviceLabel: 'librelog:deviceLabel',
});
const DEFAULT_DEVICE_LABEL = 'My LibreLog device';

let singletonPromise = null;
let singletonClient = null;
let mutationListener = null;
let identityChannel = null;

async function readState(key, fallback = null) {
  const database = await openDB();
  const transaction = database.transaction(SYNC_STORE_NAMES.state, 'readonly');
  const record = await requestToPromise(
    transaction.objectStore(SYNC_STORE_NAMES.state).get(key),
  );
  return record?.value ?? fallback;
}

async function writeState(key, value) {
  const database = await openDB();
  const transaction = database.transaction(SYNC_STORE_NAMES.state, 'readwrite');
  const completion = waitForTransaction(transaction);
  transaction.objectStore(SYNC_STORE_NAMES.state).put({ key, value });
  await completion;
}

function validateDeviceLabel(value) {
  const label = String(value || '').trim();
  if (!label || label.length > 100) throw new Error('Device label must be 1–100 characters');
  return label;
}

export async function getLibreSyncPreferences() {
  const [consent, serverUrl, deviceLabel] = await Promise.all([
    readState(PREFERENCE_KEYS.consent, false),
    readState(PREFERENCE_KEYS.serverUrl, ''),
    readState(PREFERENCE_KEYS.deviceLabel, DEFAULT_DEVICE_LABEL),
  ]);
  return {
    consent: consent === true,
    serverUrl: typeof serverUrl === 'string' ? serverUrl : '',
    deviceLabel: typeof deviceLabel === 'string' && deviceLabel
      ? deviceLabel
      : DEFAULT_DEVICE_LABEL,
  };
}

async function disposeSingleton() {
  if (singletonClient) singletonClient.stopAutomaticSync();
  if (mutationListener && typeof window !== 'undefined') {
    window.removeEventListener('librelog:local-mutation', mutationListener);
  }
  mutationListener = null;
  singletonClient = null;
  singletonPromise = null;
}

function installIdentityChannel() {
  if (identityChannel || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  identityChannel = new BroadcastChannel('librelog:libresync-identity');
  identityChannel.addEventListener('message', async event => {
    if (event.data?.type !== 'device-identity-changed' || !singletonClient) return;
    const status = await singletonClient.getStatus();
    if (status.deviceId !== event.data.deviceId) await disposeSingleton();
  });
}

function announceDeviceIdentity(deviceId) {
  installIdentityChannel();
  identityChannel?.postMessage({ type: 'device-identity-changed', deviceId });
}

export function createLibreLogSyncClient({
  database = openDB,
  deviceId,
  deviceLabel,
  transportFactory,
  secretStorage,
  readLocalEntities = readLibreLogLocalEntities,
  createSafetyBackup = createPortableSafetyBackup,
  applyMaterialized = applyLibreLogMaterialized,
} = {}) {
  if (!deviceId) throw new Error('LibreSync device ID is required');
  return new LibreSyncClient({
    applicationId: LIBRELOG_APP_ID,
    appSchemaVersion: LIBRELOG_APP_SCHEMA_VERSION,
    deviceId,
    deviceLabel: validateDeviceLabel(deviceLabel),
    db: database,
    domainStores: SYNCED_DOMAIN_STORES,
    applyMaterialized,
    secretStorage: secretStorage || new IndexedDbSecretStorage(database, 'librelog'),
    transportFactory: transportFactory || (serverUrl => new HttpSyncTransport(serverUrl)),
    readLocalEntities,
    createSafetyBackup,
    supportedAppSchemaVersions: [LIBRELOG_APP_SCHEMA_VERSION],
    maxChangesPerOperation: 200,
    maxPushBatchOperations: 100,
    pullPageSize: 100,
    debounceMs: 650,
  });
}

export async function getLibreSyncClient() {
  if (singletonPromise) {
    const client = await singletonPromise;
    const database = await openDB();
    const durableDeviceId = await getOrCreateSyncDeviceId(database);
    if ((await client.getStatus()).deviceId === durableDeviceId) return client;
    await disposeSingleton();
  }
  singletonPromise = (async () => {
    const database = await openDB();
    const [{ deviceLabel }, deviceId] = await Promise.all([
      getLibreSyncPreferences(),
      getOrCreateSyncDeviceId(database),
    ]);
    const client = createLibreLogSyncClient({ deviceId, deviceLabel });
    singletonClient = client;
    installIdentityChannel();
    if (typeof window !== 'undefined') {
      mutationListener = async () => {
        // Another tab may have created the shared connection after this tab
        // initialized while disconnected. A recorded mutation proves the
        // connection now exists, so start listeners before scheduling it.
        const activeClient = await getLibreSyncClient();
        activeClient.startAutomaticSync();
        activeClient.notifyLocalMutation();
      };
      window.addEventListener('librelog:local-mutation', mutationListener);
    }
    return client;
  })().catch(error => {
    singletonPromise = null;
    throw error;
  });
  return singletonPromise;
}

export async function setLibreSyncPreferences({ consent, serverUrl, deviceLabel }) {
  const client = await getLibreSyncClient();
  const status = await client.getStatus();
  if (consent === false && status.connected) {
    throw new Error('Disconnect this device before withdrawing remote-data consent');
  }
  const normalizedLabel = validateDeviceLabel(deviceLabel);
  const normalizedUrl = String(serverUrl || '').trim();
  if (normalizedUrl.length > 2048) throw new Error('Server URL is too long');
  await Promise.all([
    writeState(PREFERENCE_KEYS.consent, consent === true),
    writeState(PREFERENCE_KEYS.serverUrl, normalizedUrl),
    writeState(PREFERENCE_KEYS.deviceLabel, normalizedLabel),
  ]);
  if (!status.connected && normalizedLabel !== status.deviceLabel) await disposeSingleton();
}

async function requireConsent() {
  const preferences = await getLibreSyncPreferences();
  if (!preferences.consent) {
    throw new Error('Confirm remote-data consent before connecting LibreSync');
  }
  return preferences;
}

export async function initializeLibreSync() {
  const preferences = await getLibreSyncPreferences();
  const client = await getLibreSyncClient();
  const status = await client.getStatus();
  if (preferences.consent && status.connected) client.startAutomaticSync();
  return status;
}

export async function createLibreSyncVault({ serverUrl, deviceLabel }) {
  await requireConsent();
  await setLibreSyncPreferences({ consent: true, serverUrl, deviceLabel });
  const client = await getLibreSyncClient();
  const metadata = await client.createVault({ serverUrl, deviceLabel, bootstrap: true });
  client.startAutomaticSync();
  await client.sync();
  return metadata;
}

export async function joinLibreSyncVault(pairingPayload, { deviceLabel } = {}) {
  const preferences = await requireConsent();
  const label = validateDeviceLabel(deviceLabel || preferences.deviceLabel);
  await writeState(PREFERENCE_KEYS.deviceLabel, label);
  const current = await getLibreSyncClient();
  const status = await current.getStatus();
  if (!status.connected && status.deviceLabel !== label) {
    await disposeSingleton();
  }
  const client = await getLibreSyncClient();
  const metadata = await client.joinVault(pairingPayload, { deviceLabel: label });
  await writeState(PREFERENCE_KEYS.serverUrl, metadata.serverUrl);
  client.startAutomaticSync();
  return metadata;
}

export async function syncLibreLogNow() {
  const client = await getLibreSyncClient();
  return client.sync();
}

export async function disconnectLibreSync() {
  const client = await getLibreSyncClient();
  await client.disconnect();
  const deviceId = await rotateSyncDeviceId(await openDB());
  await disposeSingleton();
  announceDeviceIdentity(deviceId);
}

export async function clearThisDeviceAndDisconnect() {
  const client = await getLibreSyncClient();
  const status = await client.getStatus();
  client.stopAutomaticSync();
  stopAutoBackup();
  const mutexName = `libresync:${LIBRELOG_APP_ID}`;
  const preservedSyncStateKey = mutexLeaseStateKey(mutexName);
  const syncBoundary = new SyncMutex(mutexName, {
    lease: createIndexedDbMutexLease(openDB, mutexName),
  });
  try {
    // Wait for any in-flight local or peer-tab sync before the existing clear
    // workflow removes domain records, backups, credentials, and sync state.
    // clearAllDataAndBackups retains its cross-tab lifecycle locks and recovery
    // backup behavior if the final IndexedDB erase fails.
    await syncBoundary.runRequired(() => clearAllDataAndBackups({ preservedSyncStateKey }));
    await disposeSingleton();
    announceDeviceIdentity(null);
  } catch (error) {
    // Nothing should resume network access after a successful clear. If the
    // guarded clear failed, however, its atomic database transaction retained
    // the connection and the existing device remains usable.
    if (status.connected) client.startAutomaticSync();
    throw error;
  }
}

export async function deleteLibreLogDataEverywhere() {
  const client = await getLibreSyncClient();
  const status = await client.getStatus();
  if (!status.connected) throw new Error('Connect LibreSync before deleting synchronized data everywhere');
  // Pull first so the deletion causally dominates every currently known head.
  // A truly concurrent offline edit still remains recoverable as a conflict.
  await client.sync();
  const deleted = await deleteAllSynchronizedData();
  await client.sync();
  return deleted;
}

export async function deleteLibreSyncVault(confirmation) {
  const client = await getLibreSyncClient();
  const status = await client.getStatus();
  if (!status.connected || !status.vaultId) throw new Error('LibreSync is not connected');
  const expected = `delete:${status.vaultId}`;
  if (confirmation !== expected) throw new Error(`Enter ${expected} to confirm vault deletion`);
  await client.deleteVault(confirmation);
  const deviceId = await rotateSyncDeviceId(await openDB());
  await disposeSingleton();
  announceDeviceIdentity(deviceId);
}
