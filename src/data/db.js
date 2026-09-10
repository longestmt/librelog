/**
 * db.js — IndexedDB wrapper for LibreLog
 * Every record: id (UUID), createdAt, updatedAt, deleted (soft-delete)
 * Stores: foods, meals, recipes, measurements, settings, apiCache
 */

import { clearAddDraft, hasAddDraftLock, withAddDraftLock } from './add-draft.js';
import {
    assertDataMutationGenerationCurrent,
    captureDataMutationGeneration,
    hasDataLifecycleLock,
    hasDataDestructiveLock,
    hasDataWriteLock,
    withDataDestructiveLock,
    withDataLifecycleLock,
    withDataWriteLock,
} from './operation-locks.js';
import { normalizeOllamaUrl } from '../integrations/ollama.js';
import {
    backfillItemIds,
    canonicalSeedFoodId,
    newId,
} from './identity.js';
import { canonicalEqual } from '@libresync/protocol';
import { clearStateExcept } from '@libresync/client';
import {
    ALL_SYNC_STORE_NAMES,
    installLibreSyncStores,
    recordLibreLogChanges,
    storesForLocalMutation,
} from '../sync/atomic.js';
import { toSyncChange } from '../sync/policy.js';

const DB_NAME = 'librelog';
// Version 3 shipped the stable meal-item migration. LibreSync adds stores and
// deterministic identities, so existing version-3 profiles need an upgrade.
const DB_VERSION = 4;
export const DATA_SCHEMA_VERSION = DB_VERSION;
export const BACKUP_SCHEMA_VERSION = 1;
const DATA_STORES = ['foods', 'meals', 'recipes', 'measurements', 'settings', 'apiCache'];
const PORTABLE_DATA_STORES = DATA_STORES.filter(name => name !== 'apiCache');
const MIGRATION_BACKUP_KEY = 'librelog_migration_backups';
const MAX_MIGRATION_BACKUPS = 3;
const BLOCKED_UPGRADE_GRACE_MS = 1_500;
const SENSITIVE_SETTING_KEYS = new Set([
    'ai_api_key',
    'ai_api_key_provider',
    'usda_api_key',
    'webdavUrl',
    'webdavUsername',
    'webdavPassword',
    'webdav_url',
    'webdav_username',
    'webdav_password',
    'webdav_connected',
    'githubPAT',
    'githubGistId',
    'credentialEncryptionEnabled',
    'credentialEncryptionVerifier',
    'libresync_deviceId',
]);
const PRIVACY_CONSENT_SETTING_PREFIX = 'privacyConsent_';
const LIBRESYNC_SETTING_PREFIX = 'libresync_';
let dbInstance = null;

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

function readMigrationBackups() {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(MIGRATION_BACKUP_KEY);
    if (!raw) return [];
    const backups = JSON.parse(raw);
    return Array.isArray(backups) ? backups : [];
}

function writeMigrationBackup(backup) {
    if (typeof localStorage === 'undefined') {
        throw new Error('Migration backup storage is not available');
    }
    const backups = [backup, ...readMigrationBackups()]
        .slice(0, MAX_MIGRATION_BACKUPS);
    localStorage.setItem(MIGRATION_BACKUP_KEY, JSON.stringify(backups));
}

function isNonPortableSettingKey(key) {
    return SENSITIVE_SETTING_KEYS.has(key)
        || (typeof key === 'string' && (
            key.startsWith(PRIVACY_CONSENT_SETTING_PREFIX)
            || key.startsWith(LIBRESYNC_SETTING_PREFIX)
        ));
}

function sanitizePortableSetting(record) {
    if (isNonPortableSettingKey(record.key)) return null;
    if (record.key !== 'ai_ollama_url') return record;

    try {
        return { ...record, value: normalizeOllamaUrl(record.value) };
    } catch {
        // Older releases allowed remote Ollama URLs. Drop that optional setting
        // without preventing the user's food, meal, and measurement recovery.
        return null;
    }
}

function filterLocalCheckpointRecords(storeName, records) {
    return storeName === 'settings'
        ? records.map(sanitizePortableSetting).filter(Boolean)
        : records;
}

function filterPortableExportRecords(storeName, records) {
    return filterLocalCheckpointRecords(storeName, records)
        .filter(record => record.deleted !== true);
}

function createStoresAndIndexes(db, transaction) {
    let foods;
    if (!db.objectStoreNames.contains('foods')) {
        foods = db.createObjectStore('foods', { keyPath: 'id' });
    } else {
        foods = transaction.objectStore('foods');
    }
    if (!foods.indexNames.contains('name')) foods.createIndex('name', 'name', { unique: false });
    if (!foods.indexNames.contains('barcode')) foods.createIndex('barcode', 'barcode', { unique: false });
    if (!foods.indexNames.contains('source')) foods.createIndex('source', 'source', { unique: false });

    let meals;
    if (!db.objectStoreNames.contains('meals')) {
        meals = db.createObjectStore('meals', { keyPath: 'id' });
    } else {
        meals = transaction.objectStore('meals');
    }
    if (!meals.indexNames.contains('date')) meals.createIndex('date', 'date', { unique: false });
    // Meal records use `type`; the legacy `mealType` index pointed at a field
    // that is never written and is removed during the v3 repair migration.
    if (meals.indexNames.contains('mealType')) meals.deleteIndex('mealType');
    if (!meals.indexNames.contains('type')) meals.createIndex('type', 'type', { unique: false });
    if (!meals.indexNames.contains('idempotencyKey')) {
        meals.createIndex('idempotencyKey', 'idempotencyKey', { unique: false });
    }

    let recipes;
    if (!db.objectStoreNames.contains('recipes')) {
        recipes = db.createObjectStore('recipes', { keyPath: 'id' });
    } else {
        recipes = transaction.objectStore('recipes');
    }
    if (!recipes.indexNames.contains('name')) recipes.createIndex('name', 'name', { unique: false });
    if (!recipes.indexNames.contains('category')) recipes.createIndex('category', 'category', { unique: false });

    let measurements;
    if (!db.objectStoreNames.contains('measurements')) {
        measurements = db.createObjectStore('measurements', { keyPath: 'id' });
    } else {
        measurements = transaction.objectStore('measurements');
    }
    if (!measurements.indexNames.contains('date')) {
        measurements.createIndex('date', 'date', { unique: false });
    }

    if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
    }

    let apiCache;
    if (!db.objectStoreNames.contains('apiCache')) {
        apiCache = db.createObjectStore('apiCache', { keyPath: 'id' });
    } else {
        apiCache = transaction.objectStore('apiCache');
    }
    if (!apiCache.indexNames.contains('source')) apiCache.createIndex('source', 'source', { unique: false });
    if (!apiCache.indexNames.contains('query')) apiCache.createIndex('query', 'query', { unique: false });
    if (!apiCache.indexNames.contains('expiresAt')) {
        apiCache.createIndex('expiresAt', 'expiresAt', { unique: false });
    }

    installLibreSyncStores(db, transaction);
}

function migrateStableIdentities(transaction) {
    const storeNames = ['foods', 'meals', 'recipes', 'settings'];
    const results = new Map();
    let pending = storeNames.length;

    const fail = () => {
        try { transaction.abort(); } catch { /* transaction is already closing */ }
    };

    const apply = () => {
        const foodsStore = transaction.objectStore('foods');
        const mealsStore = transaction.objectStore('meals');
        const recipesStore = transaction.objectStore('recipes');
        const settingsStore = transaction.objectStore('settings');
        const foodIdMap = new Map();

        for (const food of results.get('foods') || []) {
            if (food?.source?.type !== 'seed') continue;
            const canonicalId = canonicalSeedFoodId(food);
            if (food.id === canonicalId) continue;
            foodIdMap.set(food.id, canonicalId);
            foodsStore.put({ ...food, id: canonicalId });
            foodsStore.delete(food.id);
        }

        const remapItems = (parentId, items) => backfillItemIds(parentId, items).map(item => ({
            ...item,
            foodId: foodIdMap.get(item.foodId) || item.foodId,
        }));

        for (const meal of results.get('meals') || []) {
            mealsStore.put({ ...meal, items: remapItems(meal.id, meal.items) });
        }
        for (const recipe of results.get('recipes') || []) {
            recipesStore.put({ ...recipe, items: remapItems(recipe.id, recipe.items) });
        }
        for (const setting of results.get('settings') || []) {
            if (!setting?.key?.startsWith('template_') || !Array.isArray(setting.value?.items)) continue;
            settingsStore.put({
                ...setting,
                value: {
                    ...setting.value,
                    items: remapItems(setting.key, setting.value.items),
                },
            });
        }
    };

    for (const name of storeNames) {
        const request = transaction.objectStore(name).getAll();
        request.onerror = fail;
        request.onsuccess = () => {
            results.set(name, request.result);
            pending -= 1;
            if (pending === 0) apply();
        };
    }
}

function normalizeMealRecordItemIds(record) {
    if (!record || !Array.isArray(record.items)) return record;
    const seen = new Set();
    let changed = false;
    const items = record.items.map(item => {
        const existingId = typeof item?.itemId === 'string' ? item.itemId.trim() : '';
        if (existingId && !seen.has(existingId)) {
            seen.add(existingId);
            if (existingId === item.itemId) return item;
            changed = true;
            return { ...item, itemId: existingId };
        }
        const itemId = uuid();
        seen.add(itemId);
        changed = true;
        return { ...item, itemId };
    });
    return changed ? { ...record, items } : record;
}

function captureMigrationBackup(db, transaction, oldVersion, onComplete) {
    const stores = PORTABLE_DATA_STORES.filter(name => db.objectStoreNames.contains(name));
    const exportedStores = {};
    let pending = stores.length;

    const fail = () => {
        try {
            transaction.abort();
        } catch {
            // The request error also stops the version-change transaction.
        }
    };

    if (pending === 0) {
        onComplete();
        return;
    }

    for (const name of stores) {
        const request = transaction.objectStore(name).getAll();
        request.onerror = fail;
        request.onsuccess = () => {
            exportedStores[name] = filterLocalCheckpointRecords(name, request.result);
            pending -= 1;
            if (pending !== 0) return;

            try {
                const timestamp = now();
                writeMigrationBackup({
                    timestamp,
                    fromVersion: oldVersion,
                    toVersion: DB_VERSION,
                    data: {
                        version: BACKUP_SCHEMA_VERSION,
                        dataVersion: oldVersion,
                        exportedAt: timestamp,
                        secretsExcluded: true,
                        stores: exportedStores,
                    },
                });
            } catch (error) {
                // The IndexedDB versionchange transaction is itself atomic.
                // A recovery checkpoint is valuable, but unavailable, full,
                // or corrupt localStorage must not strand an existing user on
                // an old schema indefinitely.
                console.warn('Could not save the optional migration checkpoint:', error);
            }
            onComplete();
        };
    }
}

/**
 * Generate a UUID v4 string
 * @returns {string}
 */
function uuid() {
    return newId();
}

/**
 * Get current timestamp as ISO string
 * @returns {string}
 */
function now() {
    return new Date().toISOString();
}

/**
 * Open or get cached IndexedDB instance
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        let settled = false;
        let blockedTimer = null;

        const rejectOnce = error => {
            if (settled) return;
            settled = true;
            if (blockedTimer) clearTimeout(blockedTimer);
            reject(error);
        };

        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            const transaction = e.target.transaction;
            if (e.oldVersion === 0) {
                createStoresAndIndexes(db, transaction);
                return;
            }
            captureMigrationBackup(db, transaction, e.oldVersion, () => {
                createStoresAndIndexes(db, transaction);
                if (e.oldVersion < DB_VERSION) migrateStableIdentities(transaction);
            });
        };

        req.onsuccess = (e) => {
            const database = e.target.result;
            if (settled) {
                database.close();
                return;
            }
            settled = true;
            if (blockedTimer) clearTimeout(blockedTimer);
            database.onversionchange = () => {
                database.close();
                if (dbInstance === database) dbInstance = null;
            };
            database.onclose = () => {
                if (dbInstance === database) dbInstance = null;
            };
            dbInstance = database;
            resolve(database);
        };

        req.onerror = (e) => rejectOnce(e.target.error);
        req.onblocked = () => {
            if (settled || blockedTimer) return;
            blockedTimer = setTimeout(() => {
                const error = new Error('Close other LibreLog tabs or windows, then reload to finish updating local data.');
                error.code = 'DB_UPGRADE_BLOCKED';
                rejectOnce(error);
            }, BLOCKED_UPGRADE_GRACE_MS);
        };
    });
}

/**
 * Get object store for a given storeName
 * @param {string} storeName
 * @param {string} mode - 'readonly' or 'readwrite'
 * @returns {Promise<IDBObjectStore>}
 */
async function getStore(storeName, mode = 'readonly') {
    const db = await openDB();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
}

/**
 * Convert IDBRequest to Promise
 * @param {IDBRequest} req
 * @returns {Promise}
 */
function promisifyRequest(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Resolve a mutation only after IndexedDB has durably committed its transaction. */
function waitForTransaction(transaction, result, label = 'IndexedDB transaction') {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(
            transaction.error || new Error(`${label} failed`),
        );
        transaction.onabort = () => reject(
            transaction.error || new Error(`${label} was aborted`),
        );
    });
}

async function finishWrite(completion, work = null) {
    try {
        if (work) await work();
        await completion;
    } catch (error) {
        try { await completion; } catch { /* consume the transaction abort */ }
        throw error;
    }
}

// ---- CRUD operations ----

/**
 * Get all non-deleted records from a store
 * @param {string} storeName
 * @returns {Promise<Array>}
 */
export async function getAll(storeName) {
    const store = await getStore(storeName);
    const items = await promisifyRequest(store.getAll());
    return items.filter(i => !i.deleted);
}

/**
 * Get a single record by ID
 * @param {string} storeName
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getById(storeName, id) {
    const store = await getStore(storeName);
    const item = await promisifyRequest(store.get(id));
    return item && !item.deleted ? item : null;
}

/**
 * Get records by index value (not deleted)
 * @param {string} storeName
 * @param {string} indexName
 * @param {any} value
 * @returns {Promise<Array>}
 */
export async function getByIndex(storeName, indexName, value) {
    const store = await getStore(storeName);
    const index = store.index(indexName);
    const items = await promisifyRequest(index.getAll(value));
    return items.filter(i => !i.deleted);
}

/**
 * Insert or update a single record
 * @param {string} storeName
 * @param {Object} data
 * @returns {Promise<Object>} - returns the stored record with metadata
 */
async function putWithWriteLockHeld(storeName, data, { context } = {}) {
    const timestamp = now();
    let record = {
        ...data,
        id: data.id || uuid(),
        createdAt: data.createdAt || timestamp,
        updatedAt: timestamp,
        deleted: false,
    };
    if (storeName === 'meals') record = normalizeMealRecordItemIds(record);
    const change = toSyncChange(storeName, record);
    if (change && context !== undefined) change.context = structuredClone(context);
    const db = await openDB();
    const transaction = db.transaction(
        change ? storesForLocalMutation([storeName]) : [storeName],
        'readwrite',
    );
    const completion = waitForTransaction(transaction, undefined, `${storeName} write`);
    transaction.objectStore(storeName).put(record);
    await finishWrite(completion, () => (
        change ? recordLibreLogChanges(transaction, [change]) : null
    ));
    return record;
}

export async function put(storeName, data, options = {}) {
    return withMaybeDataWriteLock(() => putWithWriteLockHeld(storeName, data, options), options);
}

/**
 * Insert or update multiple records in a transaction
 * @param {string} storeName
 * @param {Array<Object>} items
 * @returns {Promise<Array>}
 */
async function putManyWithWriteLockHeld(storeName, items) {
    const db = await openDB();
    const timestamp = now();
    const records = items.map(data => {
        let record = {
            ...data,
            id: data.id || uuid(),
            createdAt: data.createdAt || timestamp,
            updatedAt: timestamp,
            deleted: data.deleted || false,
        };
        if (storeName === 'meals') record = normalizeMealRecordItemIds(record);
        return record;
    });
    const changes = records
        .map(record => toSyncChange(storeName, record, record.deleted ? 'delete' : 'put'))
        .filter(Boolean);
    const tx = db.transaction(
        changes.length ? storesForLocalMutation([storeName]) : [storeName],
        'readwrite',
    );
    const completion = waitForTransaction(tx, undefined, `${storeName} batch write`);
    const store = tx.objectStore(storeName);
    for (const record of records) store.put(record);
    await finishWrite(completion, () => (
        changes.length ? recordLibreLogChanges(tx, changes) : null
    ));
    return records;
}

export async function putMany(storeName, items, options = {}) {
    return withMaybeDataWriteLock(() => putManyWithWriteLockHeld(storeName, items), options);
}

/**
 * Soft-delete a record (mark deleted=true)
 * @param {string} storeName
 * @param {string} id
 * @returns {Promise<void>}
 */
async function softDeleteWithWriteLockHeld(storeName, id, { context } = {}) {
    const synchronized = Boolean(toSyncChange(storeName, { id, key: id }, 'delete'));
    const db = await openDB();
    const transaction = db.transaction(
        synchronized ? storesForLocalMutation([storeName]) : [storeName],
        'readwrite',
    );
    const completion = waitForTransaction(transaction, undefined, `${storeName} delete`);
    const store = transaction.objectStore(storeName);
    const item = await promisifyRequest(store.get(id));
    if (item) {
        item.deleted = true;
        item.updatedAt = now();
        store.put(item);
        const change = toSyncChange(storeName, item, 'delete');
        if (change && context !== undefined) change.context = structuredClone(context);
        await finishWrite(completion, () => (
            change ? recordLibreLogChanges(transaction, [change]) : null
        ));
        return;
    }
    await finishWrite(completion);
}

export async function softDelete(storeName, id, options = {}) {
    return withMaybeDataWriteLock(
        () => softDeleteWithWriteLockHeld(storeName, id, options),
        options,
    );
}

/**
 * Hard-delete all records in a store (irreversible)
 * @param {string} storeName
 * @returns {Promise<void>}
 */
async function hardDeleteAllWithWriteLockHeld(storeName) {
    if (storeName !== 'apiCache') {
        throw new Error('Hard deletion failed: it is restricted to the local-only API cache');
    }
    const db = await openDB();
    const transaction = db.transaction(storeName, 'readwrite');
    const committed = waitForTransaction(transaction, undefined, `${storeName} clear`);
    transaction.objectStore(storeName).clear();
    return committed;
}

export async function hardDeleteAll(storeName, options = {}) {
    return withMaybeDataWriteLock(() => hardDeleteAllWithWriteLockHeld(storeName), options);
}

// ---- Settings helpers ----

/**
 * Get a setting by key
 * @param {string} key
 * @param {any} defaultValue
 * @returns {Promise<any>}
 */
export async function getSetting(key, defaultValue = null) {
    const store = await getStore('settings');
    const item = await promisifyRequest(store.get(key));
    return item && item.deleted !== true ? item.value : defaultValue;
}

/**
 * Set a setting by key
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
async function setSettingWithWriteLockHeld(key, value, { context } = {}) {
    const record = { key, value, updatedAt: now(), deleted: false };
    const change = toSyncChange('settings', record);
    if (change && context !== undefined) change.context = structuredClone(context);
    const db = await openDB();
    const transaction = db.transaction(
        change ? storesForLocalMutation(['settings']) : ['settings'],
        'readwrite',
    );
    const completion = waitForTransaction(transaction, undefined, 'Settings write');
    transaction.objectStore('settings').put(record);
    await finishWrite(completion, () => (
        change ? recordLibreLogChanges(transaction, [change]) : null
    ));
}

export async function setSetting(key, value, options = {}) {
    return withMaybeDataWriteLock(() => setSettingWithWriteLockHeld(key, value, options), options);
}

/** Commit several settings together or not at all. */
async function setSettingsWithWriteLockHeld(entries) {
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.key !== 'string')) {
        throw new TypeError('Settings must be an array of keyed entries');
    }
    const updatedAt = now();
    const records = entries.map(({ key, value }) => ({ key, value, updatedAt, deleted: false }));
    const changes = records.map(record => toSyncChange('settings', record)).filter(Boolean);
    const db = await openDB();
    const tx = db.transaction(
        changes.length ? storesForLocalMutation(['settings']) : ['settings'],
        'readwrite',
    );
    const completion = waitForTransaction(tx, undefined, 'Settings transaction');
    const store = tx.objectStore('settings');
    for (const record of records) store.put(record);
    await finishWrite(completion, () => (
        changes.length ? recordLibreLogChanges(tx, changes) : null
    ));
}


export async function setSettings(entries, options = {}) {
    return withMaybeDataWriteLock(() => setSettingsWithWriteLockHeld(entries), options);
}

async function deleteSettingWithWriteLockHeld(key, { context } = {}) {
    const record = { key, value: null, updatedAt: now(), deleted: true };
    const change = toSyncChange('settings', record, 'delete');
    if (change && context !== undefined) change.context = structuredClone(context);
    const db = await openDB();
    const transaction = db.transaction(
        change ? storesForLocalMutation(['settings']) : ['settings'],
        'readwrite',
    );
    const completion = waitForTransaction(transaction, undefined, 'Settings delete');
    transaction.objectStore('settings').put(record);
    await finishWrite(completion, () => (
        change ? recordLibreLogChanges(transaction, [change]) : null
    ));
}

export async function deleteSetting(key, options = {}) {
    return withMaybeDataWriteLock(() => deleteSettingWithWriteLockHeld(key, options), options);
}

// ---- Export / Import ----

/**
 * Export all data from all stores
 * @returns {Promise<Object>}
 */
async function exportAllDataWithLifecycleLockHeld() {
    const db = await openDB();
    const data = {
        version: BACKUP_SCHEMA_VERSION,
        dataVersion: DATA_SCHEMA_VERSION,
        exportedAt: now(),
        secretsExcluded: true,
        stores: {},
    };
    const stores = PORTABLE_DATA_STORES.filter(name => db.objectStoreNames.contains(name));
    const transaction = db.transaction(stores, 'readonly');
    const completed = waitForTransaction(transaction, undefined, 'Data export');
    const reads = stores.map(async name => {
        const records = await promisifyRequest(transaction.objectStore(name).getAll());
        return [name, filterPortableExportRecords(name, records)];
    });
    const [entries] = await Promise.all([Promise.all(reads), completed]);
    for (const [name, records] of entries) data.stores[name] = records;
    return data;
}

export async function exportAllData({ lifecycleToken, lockManager } = {}) {
    if (hasDataLifecycleLock(lifecycleToken)) {
        return exportAllDataWithLifecycleLockHeld();
    }
    return withDataLifecycleLock(
        token => exportAllData({ lifecycleToken: token }),
        lockManager,
    );
}

function isCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year
        && date.getMonth() === month - 1
        && date.getDate() === day;
}

function validatePositiveNumber(value, label) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
        throw new Error(`Backup ${label} must be a positive number`);
    }
}

function validateOptionalNutritionValue(value, label) {
    if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        throw new Error(`Backup ${label} must be a non-negative number or null`);
    }
}

function validateOptionalString(value, label) {
    if (value != null && typeof value !== 'string') {
        throw new Error(`Backup ${label} must be a string or null`);
    }
}

function validateServingSize(servingSize, label) {
    if (!servingSize || typeof servingSize !== 'object' || Array.isArray(servingSize)) {
        throw new Error(`Backup ${label} requires a serving size`);
    }
    validatePositiveNumber(servingSize.quantity, `${label} serving quantity`);
    if (typeof servingSize.unit !== 'string' || !servingSize.unit.trim()) {
        throw new Error(`Backup ${label} requires a serving unit`);
    }
    if (servingSize.aliases != null && !Array.isArray(servingSize.aliases)) {
        throw new Error(`Backup ${label} serving aliases must be an array`);
    }
    if (servingSize.gramsPerUnit != null) {
        validatePositiveNumber(servingSize.gramsPerUnit, `${label} grams per unit`);
    }
    for (const alias of servingSize.aliases || []) {
        if (!alias || typeof alias !== 'object' || typeof alias.unit !== 'string' || !alias.unit.trim()) {
            throw new Error(`Backup ${label} contains an invalid serving alias`);
        }
        validatePositiveNumber(alias.gramsPerUnit, `${label} alias grams per unit`);
    }
}

function validateNutrients(nutrients, label) {
    if (!nutrients || typeof nutrients !== 'object' || Array.isArray(nutrients)) {
        throw new Error(`Backup ${label} requires nutrition data`);
    }
    if ('kcal' in nutrients || 'protein' in nutrients || 'carbs' in nutrients || 'fat' in nutrients) {
        validateOptionalNutritionValue(nutrients.kcal, `${label} calories`);
        validateOptionalNutritionValue(nutrients.protein, `${label} protein`);
        validateOptionalNutritionValue(nutrients.carbs, `${label} carbohydrates`);
        validateOptionalNutritionValue(nutrients.fat, `${label} fat`);
        validateOptionalNutritionValue(nutrients.fiber, `${label} fiber`);
        validateOptionalNutritionValue(nutrients.sodium, `${label} sodium`);
    } else {
        validateOptionalNutritionValue(nutrients.energy?.kcal, `${label} calories`);
        validateOptionalNutritionValue(nutrients.macros?.protein?.g, `${label} protein`);
        validateOptionalNutritionValue(nutrients.macros?.carbs?.g, `${label} carbohydrates`);
        validateOptionalNutritionValue(nutrients.macros?.fat?.g, `${label} fat`);
        validateOptionalNutritionValue(nutrients.fiber?.g, `${label} fiber`);
        validateOptionalNutritionValue(nutrients.sodium?.mg, `${label} sodium`);
    }
}

function validateMealItem(item, label) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`Backup ${label} contains an invalid item`);
    }
    if (typeof item.foodId !== 'string' || !item.foodId) {
        throw new Error(`Backup ${label} item requires a food ID`);
    }
    if (item.itemId != null && typeof item.itemId !== 'string') {
        throw new Error(`Backup ${label} item ID must be a string`);
    }
    if (item.itemId === '') {
        throw new Error(`Backup ${label} item ID must not be empty`);
    }
    validatePositiveNumber(item.quantity, `${label} item quantity`);
    if (typeof item.unit !== 'string' || !item.unit.trim()) {
        throw new Error(`Backup ${label} item requires a unit`);
    }
    validateOptionalString(item.itemId, `${label} item ID`);
    validateOptionalString(item.nameSnapshot, `${label} item name`);
    validateOptionalString(item.notes, `${label} item notes`);
    if (item.nutrients != null) validateNutrients(item.nutrients, `${label} item`);
}

function validatePortableSetting(record) {
    if (record.key !== 'ai_usage_log') return;
    if (!Array.isArray(record.value) || record.value.length > 100) {
        throw new Error('Backup AI usage log must be an array of at most 100 entries');
    }
    for (const entry of record.value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error('Backup AI usage log contains an invalid entry');
        }
        const date = typeof entry.date === 'string' ? new Date(entry.date) : null;
        if (!date || Number.isNaN(date.getTime())) {
            throw new Error('Backup AI usage log contains an invalid date');
        }
        if (entry.provider != null
            && (typeof entry.provider !== 'string' || entry.provider.length > 80)) {
            throw new Error('Backup AI usage log contains an invalid provider');
        }
        for (const field of ['tokens', 'cost']) {
            const value = entry[field];
            if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
                throw new Error(`Backup AI usage log contains invalid ${field}`);
            }
        }
    }
}

function validateStoreRecord(name, record) {
    if (name === 'settings') {
        if (typeof record.key !== 'string' || !record.key) {
            throw new Error('Backup contains a setting without a valid key');
        }
        validatePortableSetting(record);
        return;
    }
    if (typeof record.id !== 'string' || !record.id) {
        throw new Error(`Backup store "${name}" contains a record without a valid id`);
    }

    if (name === 'foods') {
        if (typeof record.name !== 'string' || !record.name.trim()) {
            throw new Error('Backup food requires a name');
        }
        validateOptionalString(record.brand, 'food brand');
        validateOptionalString(record.category, 'food category');
        if (record.source != null) {
            if (typeof record.source !== 'object' || Array.isArray(record.source)) {
                throw new Error('Backup food source must be an object or null');
            }
            validateOptionalString(record.source.type, 'food source type');
            validateOptionalString(record.source.id, 'food source ID');
        }
        validateServingSize(record.servingSize, 'food');
        validateNutrients(record.nutrients, 'food');
    } else if (name === 'meals') {
        if (!isCalendarDate(record.date)) throw new Error('Backup meal requires a valid date');
        if (!['breakfast', 'lunch', 'dinner', 'snacks'].includes(record.type)) {
            throw new Error('Backup meal requires a valid meal type');
        }
        if (!Array.isArray(record.items) || (record.items.length === 0 && record.deleted !== true)) {
            throw new Error('Backup meal requires an item array');
        }
        record.items.forEach(item => validateMealItem(item, 'meal'));
    } else if (name === 'recipes') {
        if (typeof record.name !== 'string' || !record.name.trim()) {
            throw new Error('Backup recipe requires a name');
        }
        if (!Array.isArray(record.items)) throw new Error('Backup recipe requires an item array');
        record.items.forEach(item => validateMealItem(item, 'recipe'));
        if (record.servings != null) validatePositiveNumber(record.servings, 'recipe servings');
    } else if (name === 'measurements') {
        if (!isCalendarDate(record.date)) throw new Error('Backup measurement requires a valid date');
        validatePositiveNumber(record.weight, 'measurement weight');
        if (record.unit != null && !['kg', 'lb'].includes(record.unit)) {
            throw new Error('Backup measurement requires a valid unit');
        }
        if (record.bodyFat != null
            && (!Number.isFinite(Number(record.bodyFat))
                || Number(record.bodyFat) < 0
                || Number(record.bodyFat) > 100)) {
            throw new Error('Backup measurement body fat must be between 0 and 100');
        }
    }
}

/**
 * Validate the outer shape and key fields of an exported backup before any
 * transaction is opened. Unknown stores are ignored for forward compatibility.
 * @param {Object} data
 * @returns {Array<string>} stores that are safe to import
 */
export function validateBackupData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Backup must be a JSON object');
    }
    if (!data.stores || typeof data.stores !== 'object' || Array.isArray(data.stores)) {
        throw new Error('Backup is missing its data stores');
    }
    if (data.version != null && (!Number.isInteger(data.version) || data.version < 1)) {
        throw new Error('Backup has an invalid schema version');
    }
    if (data.version != null && data.version > BACKUP_SCHEMA_VERSION) {
        throw new Error(`Backup schema version ${data.version} is not supported`);
    }
    if (data.dataVersion != null && (!Number.isInteger(data.dataVersion) || data.dataVersion < 1)) {
        throw new Error('Backup has an invalid data schema version');
    }
    if (data.dataVersion != null && data.dataVersion > DATA_SCHEMA_VERSION) {
        throw new Error(`Data schema version ${data.dataVersion} is not supported`);
    }

    // API cache was included in older backups. It contains private search terms
    // and is deliberately ignored during portable import.
    const available = PORTABLE_DATA_STORES.filter(name => Object.hasOwn(data.stores, name));
    if (available.length === 0) throw new Error('Backup contains no recognized data stores');

    let totalRecords = 0;
    for (const name of available) {
        const records = data.stores[name];
        if (!Array.isArray(records)) throw new Error(`Backup store "${name}" must be an array`);
        totalRecords += records.length;
        if (totalRecords > 250_000) {
            throw new Error('Backup contains too many records');
        }
        for (const record of records) {
            if (!record || typeof record !== 'object' || Array.isArray(record)) {
                throw new Error(`Backup store "${name}" contains an invalid record`);
            }
            validateStoreRecord(name, record);
        }
    }
    return available;
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    );
}

function canonicalStore(records, storeName) {
    const key = storeName === 'settings' ? 'key' : 'id';
    return records
        .map(record => canonicalize(record))
        .sort((left, right) => String(left[key] || '').localeCompare(String(right[key] || '')));
}

function matchesPortableSnapshot(expectedData, currentStores) {
    if (!expectedData?.stores) return true;
    return PORTABLE_DATA_STORES.every(name => JSON.stringify(canonicalStore(
        filterPortableExportRecords(name, currentStores[name] || []),
        name,
    )) === JSON.stringify(canonicalStore(expectedData.stores[name] || [], name)));
}

function normalizeImportedStores(data, stores) {
    const normalized = Object.fromEntries(stores.map(name => [
        name,
        (data.stores[name] || [])
            .map(record => (name === 'settings' ? sanitizePortableSetting(record) : record))
            .filter(Boolean)
            .map(record => structuredClone(record)),
    ]));
    const foodIdMap = new Map();

    for (const food of normalized.foods || []) {
        if (food?.source?.type !== 'seed') continue;
        const canonicalId = canonicalSeedFoodId(food);
        foodIdMap.set(food.id, canonicalId);
        food.id = canonicalId;
    }

    const remapItems = (parentId, items) => backfillItemIds(parentId, items).map(item => ({
        ...item,
        foodId: foodIdMap.get(item.foodId) || item.foodId,
    }));
    for (const meal of normalized.meals || []) meal.items = remapItems(meal.id, meal.items);
    for (const recipe of normalized.recipes || []) recipe.items = remapItems(recipe.id, recipe.items);
    for (const setting of normalized.settings || []) {
        if (setting?.key?.startsWith('template_') && Array.isArray(setting.value?.items)) {
            setting.value.items = remapItems(setting.key, setting.value.items);
        }
    }
    return normalized;
}

/**
 * Import all data into stores
 * @param {Object} data - exported data object
 * @param {boolean} merge - if false, clears stores first
 * @returns {Promise<void>}
 */
async function importAllDataWithLocksHeld(data, merge = false, { expectedCurrentData } = {}) {
    const availableStores = validateBackupData(data);
    const normalizedStores = normalizeImportedStores(data, availableStores);
    const db = await openDB();
    const targetStores = (merge ? availableStores : PORTABLE_DATA_STORES)
        .filter(name => db.objectStoreNames.contains(name));
    const domainStores = !merge && db.objectStoreNames.contains('apiCache')
        ? [...targetStores, 'apiCache']
        : targetStores;
    const tx = db.transaction(storesForLocalMutation(domainStores), 'readwrite');
    const completion = waitForTransaction(tx, undefined, 'Import transaction');

    try {
        // Read the old record set before issuing writes. Replacement is a causal
        // diff: synchronized removals become tombstones and existing heads stay
        // intact, instead of clearing domain stores behind stale sync metadata.
        const existingByStore = new Map(await Promise.all(targetStores.map(async name => [
            name,
            await promisifyRequest(tx.objectStore(name).getAll()),
        ])));

        if (!merge && expectedCurrentData) {
            const currentStores = Object.fromEntries(existingByStore);
            if (!matchesPortableSnapshot(expectedCurrentData, currentStores)) {
                const error = new Error('Local data changed while the safety backup was being verified. Nothing was replaced; try again.');
                error.code = 'DATA_CHANGED_DURING_REPLACE';
                throw error;
            }
        }

        const changes = [];
        const timestamp = now();

        for (const name of targetStores) {
            const store = tx.objectStore(name);
            const keyFor = record => (name === 'settings' ? record.key : record.id);
            const existing = existingByStore.get(name) || [];
            const existingByKey = new Map(existing.map(record => [keyFor(record), record]));
            const incoming = (normalizedStores[name] || [])
                .filter(record => record.deleted !== true)
                // Older backup formats may contain device-only settings. They
                // are never imported into another profile.
                .map(record => ({ ...structuredClone(record), deleted: false }));
            const incomingByKey = new Map(incoming.map(record => [keyFor(record), record]));

            if (merge) {
                // Merge is intentionally local-first. New stable identities are
                // ordinary synchronized puts; a known ID (including a local
                // tombstone) is never silently overwritten or resurrected.
                for (const record of incoming) {
                    const key = keyFor(record);
                    if (existingByKey.has(key)) continue;
                    store.put(record);
                    const change = toSyncChange(name, record, 'put');
                    if (change) changes.push(change);
                }
                continue;
            }

            for (const oldRecord of existing) {
                const key = keyFor(oldRecord);
                if (name === 'settings') {
                    // Credentials and the stable LibreSync device identity are
                    // device-local. WebDAV consent is retained only because the
                    // active restore itself may depend on that granted access;
                    // every other consent flag is reset rather than imported.
                    const preserve = SENSITIVE_SETTING_KEYS.has(key)
                        || (typeof key === 'string' && key.startsWith(LIBRESYNC_SETTING_PREFIX))
                        || (key === 'privacyConsent_webdav' && oldRecord.value === true);
                    if (preserve) {
                        incomingByKey.delete(key);
                        continue;
                    }
                    if (typeof key === 'string' && key.startsWith(PRIVACY_CONSENT_SETTING_PREFIX)) {
                        incomingByKey.delete(key);
                        store.delete(key);
                        continue;
                    }
                }

                const replacement = incomingByKey.get(key);
                if (replacement) {
                    incomingByKey.delete(key);
                    if (!canonicalEqual(oldRecord, replacement)) {
                        store.put(replacement);
                        const change = toSyncChange(name, replacement, 'put');
                        if (change) changes.push(change);
                    }
                    continue;
                }

                const deletion = toSyncChange(name, oldRecord, 'delete');
                if (deletion) {
                    if (oldRecord.deleted !== true) {
                        store.put({ ...oldRecord, deleted: true, updatedAt: timestamp });
                        changes.push(deletion);
                    }
                } else {
                    store.delete(key);
                }
            }

            for (const replacement of incomingByKey.values()) {
                store.put(replacement);
                const change = toSyncChange(name, replacement, 'put');
                if (change) changes.push(change);
            }
        }

        if (!merge && domainStores.includes('apiCache')) {
            tx.objectStore('apiCache').clear();
        }
        if (changes.length) await recordLibreLogChanges(tx, changes);
        await completion;
    } catch (error) {
        try { tx.abort(); } catch { /* transaction already failed or completed */ }
        try { await completion; } catch { /* consume the transaction failure */ }
        throw error;
    }
    if (!merge) clearAddDraft();
}

export async function importAllData(data, merge = false, {
    lifecycleToken,
    draftLockToken,
    destructiveLockToken,
    writeLockToken,
    expectedCurrentData,
    lockManager,
} = {}) {
    if (!hasDataLifecycleLock(lifecycleToken)) {
        return withDataLifecycleLock(
            token => importAllData(data, merge, {
                lifecycleToken: token,
                draftLockToken,
                destructiveLockToken,
                writeLockToken,
                expectedCurrentData,
                lockManager,
            }),
            lockManager,
        );
    }
    if (!hasDataDestructiveLock(destructiveLockToken)) {
        return withDataDestructiveLock(
            token => importAllData(data, merge, {
                lifecycleToken,
                draftLockToken,
                destructiveLockToken: token,
                writeLockToken,
                expectedCurrentData,
                lockManager,
            }),
            lockManager,
        );
    }
    if (!hasAddDraftLock(draftLockToken)) {
        return withAddDraftLock(
            token => importAllData(data, merge, {
                lifecycleToken,
                draftLockToken: token,
                destructiveLockToken,
                writeLockToken,
                expectedCurrentData,
                lockManager,
            }),
            lockManager,
            { destructiveLockToken },
        );
    }
    if (!hasDataWriteLock(writeLockToken)) {
        return withDataWriteLock(
            token => importAllData(data, merge, {
                lifecycleToken,
                draftLockToken,
                destructiveLockToken,
                writeLockToken: token,
                expectedCurrentData,
                lockManager,
            }),
            lockManager,
            { destructiveLockToken },
        );
    }
    return importAllDataWithLocksHeld(data, merge, { expectedCurrentData });
}

/**
 * Clear all data from all stores
 * @returns {Promise<void>}
 */
async function clearAllDataWithLocksHeld({ preservedSyncStateKey } = {}) {
    const db = await openDB();
    const stores = [...DATA_STORES, ...ALL_SYNC_STORE_NAMES]
        .filter(name => db.objectStoreNames.contains(name));
    const tx = db.transaction(stores, 'readwrite');
    const completion = waitForTransaction(tx, undefined, 'Clear transaction');
    try {
        for (const name of stores) {
            if (name === 'libresync_state' && preservedSyncStateKey) {
                await clearStateExcept(tx, preservedSyncStateKey);
            } else {
                tx.objectStore(name).clear();
            }
        }
        await completion;
    } catch (error) {
        try { tx.abort(); } catch { /* transaction already failed or completed */ }
        try { await completion; } catch { /* consume the transaction failure */ }
        throw error;
    }
    clearMigrationBackups();
    clearAddDraft();
}

export async function clearAllData({
    lifecycleToken,
    draftLockToken,
    destructiveLockToken,
    writeLockToken,
    lockManager,
    preservedSyncStateKey,
} = {}) {
    if (!hasDataLifecycleLock(lifecycleToken)) {
        return withDataLifecycleLock(
            token => clearAllData({
                lifecycleToken: token,
                draftLockToken,
                destructiveLockToken,
                writeLockToken,
                lockManager,
                preservedSyncStateKey,
            }),
            lockManager,
        );
    }
    if (!hasDataDestructiveLock(destructiveLockToken)) {
        return withDataDestructiveLock(
            token => clearAllData({
                lifecycleToken,
                draftLockToken,
                destructiveLockToken: token,
                writeLockToken,
                lockManager,
                preservedSyncStateKey,
            }),
            lockManager,
        );
    }
    if (!hasAddDraftLock(draftLockToken)) {
        return withAddDraftLock(
            token => clearAllData({
                lifecycleToken,
                draftLockToken: token,
                destructiveLockToken,
                writeLockToken,
                lockManager,
                preservedSyncStateKey,
            }),
            lockManager,
            { destructiveLockToken },
        );
    }
    if (!hasDataWriteLock(writeLockToken)) {
        return withDataWriteLock(
            token => clearAllData({
                lifecycleToken,
                draftLockToken,
                destructiveLockToken,
                writeLockToken: token,
                lockManager,
                preservedSyncStateKey,
            }),
            lockManager,
            { destructiveLockToken },
        );
    }
    return clearAllDataWithLocksHeld({ preservedSyncStateKey });
}

/**
 * Tombstone every currently live synchronized entity in one transaction.
 * Local-only records and the connection itself are deliberately retained.
 * The caller must obtain explicit user confirmation before invoking this.
 * @returns {Promise<number>} number of delete changes recorded
 */
async function deleteAllSynchronizedDataWithWriteLockHeld() {
    const db = await openDB();
    const domainStores = PORTABLE_DATA_STORES
        .filter(name => db.objectStoreNames.contains(name));
    const tx = db.transaction(storesForLocalMutation(domainStores), 'readwrite');
    const completion = waitForTransaction(tx, undefined, 'Synchronized data deletion');

    try {
        const recordsByStore = new Map(await Promise.all(domainStores.map(async name => [
            name,
            await promisifyRequest(tx.objectStore(name).getAll()),
        ])));
        const changes = [];
        const timestamp = now();
        for (const name of domainStores) {
            const store = tx.objectStore(name);
            for (const record of recordsByStore.get(name) || []) {
                if (record.deleted === true) continue;
                const change = toSyncChange(name, record, 'delete');
                if (!change) continue;
                store.put({ ...record, deleted: true, updatedAt: timestamp });
                changes.push(change);
            }
        }
        if (changes.length) await recordLibreLogChanges(tx, changes);
        await completion;
        return changes.length;
    } catch (error) {
        try { tx.abort(); } catch { /* transaction already failed or completed */ }
        try { await completion; } catch { /* consume the transaction failure */ }
        throw error;
    }
}

export async function deleteAllSynchronizedData(options = {}) {
    return withMaybeDataWriteLock(deleteAllSynchronizedDataWithWriteLockHeld, options);
}

export function getMigrationBackups() {
    try {
        return readMigrationBackups().map(backup => ({
            timestamp: backup.timestamp,
            fromVersion: backup.fromVersion,
            toVersion: backup.toVersion,
        }));
    } catch {
        return [];
    }
}

export function getMigrationBackupData(timestamp) {
    const backup = readMigrationBackups()
        .find(item => item.timestamp === timestamp);
    if (!backup?.data) throw new Error('Migration checkpoint was not found');
    return structuredClone(backup.data);
}

export function clearMigrationBackups() {
    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(MIGRATION_BACKUP_KEY);
    }
}

export { uuid, now, openDB };
