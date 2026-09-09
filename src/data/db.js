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

const DB_NAME = 'librelog';
const DB_VERSION = 3;
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
]);
const PRIVACY_CONSENT_SETTING_PREFIX = 'privacyConsent_';

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
        || (typeof key === 'string' && key.startsWith(PRIVACY_CONSENT_SETTING_PREFIX));
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
    if (!meals.indexNames.contains('mealType')) meals.createIndex('mealType', 'mealType', { unique: false });
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

function migrateMealsToStableItemIds(transaction) {
    const request = transaction.objectStore('meals').openCursor();
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const normalized = normalizeMealRecordItemIds(cursor.value);
        if (normalized !== cursor.value) cursor.update(normalized);
        cursor.continue();
    };
}

function captureMigrationBackup(db, transaction, oldVersion, onComplete) {
    const stores = DATA_STORES.filter(name => db.objectStoreNames.contains(name));
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
    return crypto.randomUUID ? crypto.randomUUID() :
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
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
                migrateMealsToStableItemIds(transaction);
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
async function putWithWriteLockHeld(storeName, data) {
    const db = await openDB();
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const timestamp = now();
    let record = {
        ...data,
        id: data.id || uuid(),
        createdAt: data.createdAt || timestamp,
        updatedAt: timestamp,
        deleted: false,
    };
    if (storeName === 'meals') record = normalizeMealRecordItemIds(record);
    const committed = waitForTransaction(transaction, record, `${storeName} write`);
    store.put(record);
    return committed;
}

export async function put(storeName, data, options = {}) {
    return withMaybeDataWriteLock(() => putWithWriteLockHeld(storeName, data), options);
}

/**
 * Insert or update multiple records in a transaction
 * @param {string} storeName
 * @param {Array<Object>} items
 * @returns {Promise<Array>}
 */
async function putManyWithWriteLockHeld(storeName, items) {
    const db = await openDB();
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const timestamp = now();
    const records = [];
    for (const data of items) {
        let record = {
            ...data,
            id: data.id || uuid(),
            createdAt: data.createdAt || timestamp,
            updatedAt: timestamp,
            deleted: data.deleted || false,
        };
        if (storeName === 'meals') record = normalizeMealRecordItemIds(record);
        store.put(record);
        records.push(record);
    }
    return waitForTransaction(tx, records, `${storeName} batch write`);
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
async function softDeleteWithWriteLockHeld(storeName, id) {
    const db = await openDB();
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const committed = waitForTransaction(transaction, undefined, `${storeName} delete`);
    const request = store.get(id);
    request.onsuccess = () => {
        const item = request.result;
        if (!item) return;
        item.deleted = true;
        item.updatedAt = now();
        store.put(item);
    };
    return committed;
}

export async function softDelete(storeName, id, options = {}) {
    return withMaybeDataWriteLock(() => softDeleteWithWriteLockHeld(storeName, id), options);
}

/**
 * Hard-delete all records in a store (irreversible)
 * @param {string} storeName
 * @returns {Promise<void>}
 */
async function hardDeleteAllWithWriteLockHeld(storeName) {
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
    return item ? item.value : defaultValue;
}

/**
 * Set a setting by key
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
async function setSettingWithWriteLockHeld(key, value) {
    const db = await openDB();
    const transaction = db.transaction('settings', 'readwrite');
    const committed = waitForTransaction(transaction, undefined, 'Settings write');
    transaction.objectStore('settings').put({ key, value, updatedAt: now() });
    return committed;
}

export async function setSetting(key, value, options = {}) {
    return withMaybeDataWriteLock(() => setSettingWithWriteLockHeld(key, value), options);
}

/** Commit several settings together or not at all. */
async function setSettingsWithWriteLockHeld(entries) {
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.key !== 'string')) {
        throw new TypeError('Settings must be an array of keyed entries');
    }
    const db = await openDB();
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    const updatedAt = now();
    for (const { key, value } of entries) store.put({ key, value, updatedAt });
    return waitForTransaction(tx, undefined, 'Settings transaction');
}


export async function setSettings(entries, options = {}) {
    return withMaybeDataWriteLock(() => setSettingsWithWriteLockHeld(entries), options);
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

/**
 * Import all data into stores
 * @param {Object} data - exported data object
 * @param {boolean} merge - if false, clears stores first
 * @returns {Promise<void>}
 */
async function importAllDataWithLocksHeld(data, merge = false, { expectedCurrentData } = {}) {
    const stores = validateBackupData(data);
    const db = await openDB();

    const transactionStores = merge
        ? stores
        : DATA_STORES.filter(name => db.objectStoreNames.contains(name));

    await new Promise((resolve, reject) => {
        const tx = db.transaction(transactionStores, 'readwrite');
        let abortReason = null;

        const writeImportedRecords = () => {
            for (const name of stores) {
                const store = tx.objectStore(name);
                for (const record of data.stores[name]) {
                    const portableRecord = name === 'settings'
                        ? sanitizePortableSetting(record)
                        : record;
                    if (!portableRecord) continue;
                    if (record.deleted === true) continue;
                    let copy = structuredClone(portableRecord);
                    if (name === 'meals') copy = normalizeMealRecordItemIds(copy);
                    if (!merge) {
                        store.put(copy);
                        continue;
                    }

                    // Merge is intentionally local-first: existing records win.
                    const key = name === 'settings' ? record.key : record.id;
                    const request = store.get(key);
                    request.onsuccess = () => {
                        if (request.result === undefined) store.put(copy);
                    };
                }
            }
        };

        const applyReplacement = (preservedSettings, currentStores) => {
            if (!matchesPortableSnapshot(expectedCurrentData, currentStores)) {
                abortReason = new Error('Local data changed while the safety backup was being verified. Nothing was replaced; try again.');
                abortReason.code = 'DATA_CHANGED_DURING_REPLACE';
                tx.abort();
                return;
            }
            for (const name of transactionStores) tx.objectStore(name).clear();
            writeImportedRecords();
            if (transactionStores.includes('settings')) {
                const settingsStore = tx.objectStore('settings');
                for (const [key, value] of preservedSettings) {
                    settingsStore.put({ key, value, updatedAt: now() });
                }
            }
        };

        try {
            if (merge) {
                writeImportedRecords();
            } else {
                // Read sensitive settings and the expected safety-snapshot
                // state inside the same transaction that performs replacement.
                // Writers are therefore ordered wholly before or after it.
                const preservedSettings = new Map();
                const currentStores = {};
                const settingKeys = [...SENSITIVE_SETTING_KEYS, 'privacyConsent_webdav'];
                let pending = settingKeys.length
                    + (expectedCurrentData ? PORTABLE_DATA_STORES.length : 0);
                const finishRead = () => {
                    pending -= 1;
                    if (pending === 0) applyReplacement(preservedSettings, currentStores);
                };

                for (const key of settingKeys) {
                    const request = tx.objectStore('settings').get(key);
                    request.onsuccess = () => {
                        const value = request.result?.value;
                        const shouldPreserve = key === 'privacyConsent_webdav'
                            ? value === true
                            : value !== undefined && value !== null && value !== '';
                        if (shouldPreserve) preservedSettings.set(key, value);
                        finishRead();
                    };
                }
                if (expectedCurrentData) {
                    for (const name of PORTABLE_DATA_STORES) {
                        const request = tx.objectStore(name).getAll();
                        request.onsuccess = () => {
                            currentStores[name] = request.result;
                            finishRead();
                        };
                    }
                }
            }
        } catch (error) {
            abortReason = error;
            tx.abort();
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Import transaction failed'));
        tx.onabort = () => reject(abortReason || tx.error || new Error('Import transaction was aborted'));
    });
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
async function clearAllDataWithLocksHeld() {
    const db = await openDB();
    const stores = DATA_STORES.filter(name => db.objectStoreNames.contains(name));
    await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite');
        for (const name of stores) tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Clear transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('Clear transaction was aborted'));
    });
    clearMigrationBackups();
    clearAddDraft();
}

export async function clearAllData({
    lifecycleToken,
    draftLockToken,
    destructiveLockToken,
    writeLockToken,
    lockManager,
} = {}) {
    if (!hasDataLifecycleLock(lifecycleToken)) {
        return withDataLifecycleLock(
            token => clearAllData({
                lifecycleToken: token,
                draftLockToken,
                destructiveLockToken,
                writeLockToken,
                lockManager,
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
            }),
            lockManager,
            { destructiveLockToken },
        );
    }
    return clearAllDataWithLocksHeld();
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
