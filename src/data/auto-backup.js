/**
 * Auto-backup system for LibreLog
 * Backs up IndexedDB data every 6 hours to prevent data loss.
 * Uses Capacitor Filesystem when available, falls back to localStorage snapshots.
 */

import { exportAllData } from './db.js';
import { getSetting, setSetting } from './db.js';

const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_BACKUPS = 7;
const BACKUP_STORAGE_KEY = 'librelog_backups';

let backupTimer = null;

/**
 * Initialize the auto-backup scheduler.
 * Checks integrity on startup, then schedules periodic backups.
 */
export async function initAutoBackup() {
  // Check if a backup is overdue
  const lastBackup = await getSetting('lastBackupTime');
  const now = Date.now();

  if (!lastBackup || (now - lastBackup) >= BACKUP_INTERVAL_MS) {
    await performBackup();
  }

  // Verify IndexedDB integrity
  await checkIntegrity();

  // Schedule recurring backups
  backupTimer = setInterval(performBackup, BACKUP_INTERVAL_MS);

  // Also backup when the app is about to be hidden/closed
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      performBackup();
    }
  });
}

/**
 * Stop the auto-backup scheduler
 */
export function stopAutoBackup() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
}

/**
 * Perform a backup of all data
 */
export async function performBackup() {
  try {
    const data = await exportAllData();
    const snapshot = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      data,
    };

    // Try Capacitor Filesystem first (native apps)
    if (await saveToFilesystem(snapshot)) {
      await setSetting('lastBackupTime', Date.now());
      await setSetting('lastBackupMethod', 'filesystem');
      return;
    }

    // Fall back to localStorage snapshots
    saveToLocalStorage(snapshot);
    await setSetting('lastBackupTime', Date.now());
    await setSetting('lastBackupMethod', 'localStorage');
  } catch (err) {
    console.error('Auto-backup failed:', err);
  }
}

/**
 * Try to save backup using Capacitor Filesystem API
 * @param {Object} snapshot - Backup snapshot
 * @returns {boolean} Whether save succeeded
 */
async function saveToFilesystem(snapshot) {
  try {
    // Dynamic import with variable to prevent Rollup from resolving at build time
    const fsModulePath = '@capacitor/filesystem';
    const { Filesystem, Directory } = await import(/* @vite-ignore */ fsModulePath);

    const filename = `librelog-backup-${snapshot.timestamp}.json`;
    const jsonStr = JSON.stringify(snapshot.data);

    await Filesystem.writeFile({
      path: `librelog-backups/${filename}`,
      data: jsonStr,
      directory: Directory.Data,
      recursive: true,
    });

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
 * Save backup to localStorage as a rolling buffer
 * @param {Object} snapshot - Backup snapshot
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

    localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(backups));
  } catch (err) {
    // localStorage may be full — try keeping fewer backups
    console.warn('localStorage backup failed, trying with fewer backups:', err);
    try {
      const minimal = [{
        timestamp: snapshot.timestamp,
        date: snapshot.date,
        data: snapshot.data,
      }];
      localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(minimal));
    } catch (e) {
      console.error('Cannot save backup to localStorage:', e);
    }
  }
}

/**
 * Check IndexedDB integrity by verifying record counts.
 * If corruption is detected, prompt user to restore from backup.
 */
async function checkIntegrity() {
  try {
    const data = await exportAllData();
    const storeNames = Object.keys(data.stores || {});
    const totalRecords = storeNames.reduce((sum, name) => sum + (data.stores[name]?.length || 0), 0);

    const lastKnownCount = await getSetting('lastRecordCount');

    if (lastKnownCount !== null && totalRecords === 0 && lastKnownCount > 10) {
      // Possible data loss — offer restore
      console.warn('Possible IndexedDB data loss detected. Last known:', lastKnownCount, 'Current:', totalRecords);
      offerRestore();
    }

    await setSetting('lastRecordCount', totalRecords);
  } catch (err) {
    console.error('Integrity check failed:', err);
  }
}

/**
 * Offer user the option to restore from most recent backup
 */
function offerRestore() {
  const event = new CustomEvent('librelog:dataloss', {
    detail: { message: 'Possible data loss detected. Would you like to restore from backup?' }
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
