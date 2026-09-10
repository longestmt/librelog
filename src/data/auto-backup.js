/**
 * Auto-backup system for LibreLog
 * Backs up IndexedDB data every 6 hours to prevent data loss.
 * Uses Capacitor Filesystem when available, falls back to localStorage snapshots.
 */

import { clearAllData, exportAllData, importAllData } from './db.js';
import { withAddDraftLock } from './add-draft.js';
import { getSetting, setSetting } from './db.js';
import {
  assertDataMutationGenerationCurrent,
  captureDataMutationGeneration,
  hasDataLifecycleLock,
  withDataDestructiveLock,
  withDataLifecycleLock,
  withDataWriteLock,
} from './operation-locks.js';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_BACKUPS = 7;
const BACKUP_STORAGE_KEY = 'librelog_backups';
const PRIVATE_BROWSER_CACHE_NAMES = ['off-api-cache'];
export const DATA_CLEARED_STORAGE_KEY = 'librelog_data_cleared_at';
const DATA_CLEARED_CHANNEL_NAME = 'librelog:data-cleared:v1';
const dataClearSourceId = globalThis.crypto?.randomUUID?.()
  || `${Date.now()}:${Math.random().toString(36).slice(2)}`;

let backupTimer = null;
let visibilityHandler = null;

function announceDataReset() {
  const message = {
    sourceId: dataClearSourceId,
    clearedAt: new Date().toISOString(),
  };
  try {
    globalThis.localStorage?.setItem(DATA_CLEARED_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // BroadcastChannel can still notify peers when storage is unavailable.
  }
  if (typeof globalThis.BroadcastChannel !== 'function') return;
  let channel = null;
  try {
    channel = new globalThis.BroadcastChannel(DATA_CLEARED_CHANNEL_NAME);
    channel.postMessage(message);
  } catch {
    // Peer notification is best-effort and must never turn a completed reset
    // into an apparent failure after the primary data has already changed.
  } finally {
    try {
      channel?.close();
    } catch {
      // Closing a one-shot notification channel is best-effort too.
    }
  }
}

/** Reload/cancel stale UI work in other same-origin tabs after a data reset. */
export function listenForExternalDataClear(callback) {
  if (typeof callback !== 'function') throw new TypeError('A data-clear callback is required');
  const onStorage = event => {
    if (event.key === DATA_CLEARED_STORAGE_KEY && event.newValue) callback();
  };
  globalThis.window?.addEventListener?.('storage', onStorage);
  let channel = null;
  try {
    if (typeof globalThis.BroadcastChannel === 'function') {
      channel = new globalThis.BroadcastChannel(DATA_CLEARED_CHANNEL_NAME);
    }
  } catch {
    // Storage events still provide a best-effort fallback when channel
    // construction is unavailable or blocked by the browser.
  }
  if (channel) {
    channel.onmessage = event => {
      if (event.data?.sourceId !== dataClearSourceId) callback();
    };
  }
  return () => {
    globalThis.window?.removeEventListener?.('storage', onStorage);
    try {
      channel?.close();
    } catch {
      // Cleanup remains safe even if the browser invalidated the channel.
    }
  };
}

/**
 * Initialize the auto-backup scheduler.
 * Checks integrity on startup, then schedules periodic backups.
 */
export async function initAutoBackup() {
  // Inspect the current database against the previous recovery point before a
  // new snapshot can replace evidence of data loss.
  await checkIntegrity();

  // Check if a backup is overdue
  const lastBackup = await getSetting('lastBackupTime');
  const now = Date.now();

  if (!lastBackup || (now - lastBackup) >= BACKUP_INTERVAL_MS) {
    await performBackup();
  }

  // Schedule recurring backups
  backupTimer = setInterval(performBackup, BACKUP_INTERVAL_MS);

  // Also backup when the app is about to be hidden/closed
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  visibilityHandler = () => {
    if (document.visibilityState === 'hidden') {
      performBackup();
    }
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

/**
 * Stop the auto-backup scheduler
 */
export function stopAutoBackup() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
}

/**
 * Perform a backup of all data
 */
async function performBackupWithLifecycleLockHeld(lifecycleToken, {
  saveFilesystem = saveToFilesystem,
  saveBrowser = saveToLocalStorage,
  captureSnapshot = false,
  recordMetadata = true,
} = {}) {
  try {
    const data = await exportAllData({ lifecycleToken });
    const snapshot = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      data,
    };

    // Try Capacitor Filesystem first (native apps)
    if (await saveFilesystem(snapshot)) {
      if (recordMetadata) {
        await setSetting('lastBackupTime', Date.now());
        await setSetting('lastBackupMethod', 'filesystem');
      }
      return captureSnapshot ? data : true;
    }

    // Fall back to localStorage snapshots
    if (!saveBrowser(snapshot)) return false;
    if (recordMetadata) {
      await setSetting('lastBackupTime', Date.now());
      await setSetting('lastBackupMethod', 'localStorage');
    }
    return captureSnapshot ? data : true;
  } catch (err) {
    console.error('Auto-backup failed:', err);
    return false;
  }
}

export async function performBackup({
  lifecycleToken,
  lockManager,
  saveFilesystem,
  saveBrowser,
  captureSnapshot,
  recordMetadata,
} = {}) {
  const dependencies = { saveFilesystem, saveBrowser, captureSnapshot, recordMetadata };
  if (hasDataLifecycleLock(lifecycleToken)) {
    return performBackupWithLifecycleLockHeld(lifecycleToken, dependencies);
  }
  return withDataLifecycleLock(
    token => performBackupWithLifecycleLockHeld(token, dependencies),
    lockManager,
  );
}

/**
 * Try to save backup using Capacitor Filesystem API
 * @param {Object} snapshot - Backup snapshot
 * @returns {Promise<boolean>} Whether save and verification succeeded
 */
async function saveToFilesystem(snapshot) {
  try {
    const filename = `librelog-backup-${snapshot.timestamp}.json`;
    const jsonStr = JSON.stringify(snapshot.data);

    await Filesystem.writeFile({
      path: `librelog-backups/${filename}`,
      data: jsonStr,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });

    const verification = await Filesystem.readFile({
      path: `librelog-backups/${filename}`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    if (verification.data !== jsonStr) {
      throw new Error('Native backup verification failed');
    }

    // Clean up old backups beyond MAX_BACKUPS
    try {
      const listing = await Filesystem.readdir({
        path: 'librelog-backups',
        directory: Directory.Data,
      });

      const backupFiles = listing.files
        .filter(f => f.name.startsWith('librelog-backup-'))
        .sort((a, b) => b.name.localeCompare(a.name));

      for (let i = MAX_BACKUPS; i < backupFiles.length; i++) {
        await Filesystem.deleteFile({
          path: `librelog-backups/${backupFiles[i].name}`,
          directory: Directory.Data,
        });
      }
    } catch (cleanupErr) {
      // Non-critical: cleanup failure doesn't invalidate the backup
      console.warn('Backup cleanup error:', cleanupErr);
    }

    return true;
  } catch (err) {
    // Capacitor Filesystem not available (web context)
    return false;
  }
}

/**
 * Save and verify a backup in localStorage as a rolling buffer.
 * @param {Object} snapshot - Backup snapshot
 * @returns {boolean} Whether save and verification succeeded
 */
function saveToLocalStorage(snapshot) {
  try {
    let backups = [];
    const stored = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (stored) {
      backups = JSON.parse(stored);
    }

    // Add new backup and keep only the latest MAX_BACKUPS
    backups.push({
      timestamp: snapshot.timestamp,
      date: snapshot.date,
      data: snapshot.data,
    });

    // Keep only last MAX_BACKUPS
    if (backups.length > MAX_BACKUPS) {
      backups = backups.slice(-MAX_BACKUPS);
    }

    const serialized = JSON.stringify(backups);
    localStorage.setItem(BACKUP_STORAGE_KEY, serialized);
    if (localStorage.getItem(BACKUP_STORAGE_KEY) !== serialized) {
      throw new Error('Browser backup verification failed');
    }
    return true;
  } catch (err) {
    // localStorage may be full — try keeping fewer backups
    console.warn('localStorage backup failed, trying with fewer backups:', err);
    try {
      const minimal = [{
        timestamp: snapshot.timestamp,
        date: snapshot.date,
        data: snapshot.data,
      }];
      const serialized = JSON.stringify(minimal);
      localStorage.setItem(BACKUP_STORAGE_KEY, serialized);
      if (localStorage.getItem(BACKUP_STORAGE_KEY) !== serialized) {
        throw new Error('Browser backup verification failed');
      }
      return true;
    } catch (e) {
      console.error('Cannot save backup to localStorage:', e);
      return false;
    }
  }
}

/**
 * Check IndexedDB integrity by verifying record counts.
 * If corruption is detected, prompt user to restore from backup.
 */
async function checkIntegrity() {
  const mutationGeneration = captureDataMutationGeneration();
  try {
    const data = await exportAllData();
    const storeNames = Object.keys(data.stores || {});
    const totalRecords = storeNames.reduce((sum, name) => sum + (data.stores[name]?.length || 0), 0);

    const lastKnownCount = await getSetting('lastRecordCount');
    const latestBackup = getLatestBrowserBackup();
    const currentMeals = data.stores.meals?.length || 0;
    const backedUpMeals = latestBackup?.data?.stores?.meals?.length || 0;

    assertDataMutationGenerationCurrent(mutationGeneration);
    if ((lastKnownCount !== null && totalRecords === 0 && lastKnownCount > 10)
      || (currentMeals === 0 && backedUpMeals > 0)) {
      // Possible data loss — offer restore
      console.warn('Possible IndexedDB data loss detected. Last known:', lastKnownCount, 'Current:', totalRecords);
      offerRestore(mutationGeneration);
    }

    await setSetting('lastRecordCount', totalRecords, { mutationGeneration });
  } catch (err) {
    console.error('Integrity check failed:', err);
  }
}

function getLatestBrowserBackup() {
  try {
    const stored = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (!stored) return null;
    const backups = JSON.parse(stored);
    return Array.isArray(backups) ? backups.at(-1) || null : null;
  } catch {
    return null;
  }
}

/**
 * Offer user the option to restore from most recent backup
 */
function offerRestore(mutationGeneration) {
  const event = new CustomEvent('librelog:dataloss', {
    detail: {
      message: 'Possible data loss detected. Would you like to restore from backup?',
      mutationGeneration,
    },
  });
  window.dispatchEvent(event);
}

/**
 * Get list of available backups for manual restore
 * @returns {Array<{timestamp: number, date: string}>}
 */
export function getAvailableBackups() {
  try {
    const stored = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (!stored) return [];
    const backups = JSON.parse(stored);
    return backups.map(b => ({ timestamp: b.timestamp, date: b.date }));
  } catch {
    return [];
  }
}

/**
 * Restore from a specific localStorage backup by timestamp
 * @param {number} timestamp - Backup timestamp to restore
 * @returns {Object|null} Backup data or null if not found
 */
export function getBackupData(timestamp) {
  try {
    const stored = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (!stored) return null;
    const backups = JSON.parse(stored);
    const backup = backups.find(b => b.timestamp === timestamp);
    return backup?.data || null;
  } catch {
    return null;
  }
}

/**
 * Remove browser and native auto-backup copies when the user chooses
 * "Clear All Data".
 */
async function removeNativeBackupDirectory() {
  try {
    await Filesystem.rmdir({
      path: 'librelog-backups',
      directory: Directory.Data,
      recursive: true,
    });
  } catch (error) {
    if (!Capacitor.isNativePlatform() || error?.code === 'OS-PLUG-FILE-0008') return;
    throw new Error('Could not remove private native backup files', { cause: error });
  }
}

async function clearAutoBackupsWithLifecycleLockHeld({
  removeFilesystemBackups = removeNativeBackupDirectory,
} = {}) {
  await removeFilesystemBackups();
  localStorage.removeItem(BACKUP_STORAGE_KEY);
}

async function removePrivateBrowserCaches(cacheStorage = globalThis.caches) {
  if (!cacheStorage?.delete) return;
  try {
    await Promise.all(PRIVATE_BROWSER_CACHE_NAMES.map(name => cacheStorage.delete(name)));
  } catch (error) {
    throw new Error('Could not remove private browser search caches', { cause: error });
  }
}

export async function clearAutoBackups({
  lifecycleToken,
  lockManager,
  removeFilesystemBackups,
} = {}) {
  const dependencies = { removeFilesystemBackups };
  if (hasDataLifecycleLock(lifecycleToken)) {
    return clearAutoBackupsWithLifecycleLockHeld(dependencies);
  }
  return withDataLifecycleLock(
    () => clearAutoBackupsWithLifecycleLockHeld(dependencies),
    lockManager,
  );
}

/**
 * Erase backups and application data as one cross-tab lifecycle operation.
 * A backup already in progress must finish first, after which its snapshot is
 * removed before the database is cleared.
 */
export async function clearAllDataAndBackups({
  lockManager,
  removeFilesystemBackups,
  removeBrowserCaches = removePrivateBrowserCaches,
  preservedSyncStateKey,
} = {}) {
  return withDataLifecycleLock(async lifecycleToken => {
    await withDataDestructiveLock(async destructiveLockToken => {
      await withAddDraftLock(async draftLockToken => {
        await withDataWriteLock(async writeLockToken => {
          // Finish all fallible external cleanup before erasing IndexedDB so a
          // cache/filesystem permission error leaves the primary data intact.
          await removeBrowserCaches();
          await clearAutoBackupsWithLifecycleLockHeld({ removeFilesystemBackups });
          try {
            await clearAllData({
              lifecycleToken,
              draftLockToken,
              destructiveLockToken,
              writeLockToken,
              lockManager,
              preservedSyncStateKey,
            });
          } catch (error) {
            // Backup deletion succeeded but the atomic IndexedDB erase did
            // not. Recreate a verified recovery point immediately while the
            // lifecycle guard still prevents another tab from changing data.
            const recovered = await performBackupWithLifecycleLockHeld(lifecycleToken, {
              recordMetadata: false,
            });
            if (!recovered) {
              const recoveryError = new Error(
                'Data clearing failed, and LibreLog could not recreate its recovery backup.',
                { cause: error },
              );
              recoveryError.code = 'CLEAR_RECOVERY_BACKUP_FAILED';
              throw recoveryError;
            }
            throw error;
          }
          // Notify peers before the destructive guard is released. Their
          // pending writes are rejected and the tabs reload to discard stale
          // in-memory state and timers.
          announceDataReset();
        }, lockManager, { destructiveLockToken });
      }, lockManager, { destructiveLockToken });
    }, lockManager);
  }, lockManager);
}

/**
 * Verify a recovery snapshot and replace data without allowing another tab's
 * clear/import operation to slip between those two steps.
 */
export async function replaceAllDataWithSafetyBackup(
  data,
  {
    lifecycleToken,
    lockManager,
    mutationGeneration,
    saveFilesystem,
    saveBrowser,
  } = {},
) {
  const replace = async token => {
    return withDataDestructiveLock(async destructiveLockToken => {
      await withAddDraftLock(async draftLockToken => {
        await withDataWriteLock(async writeLockToken => {
          const recoverySnapshot = await performBackupWithLifecycleLockHeld(token, {
            captureSnapshot: true,
            // Metadata writes would make this snapshot stale before the guarded
            // replacement transaction begins.
            recordMetadata: false,
            saveFilesystem,
            saveBrowser,
          });
          if (!recoverySnapshot) {
            throw new Error('Full replacement stopped because a safety backup could not be verified');
          }
          await importAllData(data, false, {
            lifecycleToken: token,
            draftLockToken,
            destructiveLockToken,
            writeLockToken,
            expectedCurrentData: recoverySnapshot,
            lockManager,
          });
          // A replacement invalidates every other tab's in-memory view just
          // like Clear does. Reload peers before they can persist stale state.
          announceDataReset();
        }, lockManager, { destructiveLockToken });
      }, lockManager, { destructiveLockToken });
    }, lockManager, { mutationGeneration });
  };

  if (hasDataLifecycleLock(lifecycleToken)) return replace(lifecycleToken);
  return withDataLifecycleLock(replace, lockManager);
}
