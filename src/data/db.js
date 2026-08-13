/**
 * db.js — IndexedDB wrapper for LibreLog
 * Every record: id (UUID), createdAt, updatedAt, deleted (soft-delete)
 * Stores: foods, meals, recipes, measurements, settings, apiCache
 */

const DB_NAME = 'librelog';
const DB_VERSION = 2;
export const DATA_SCHEMA_VERSION = DB_VERSION;
export const BACKUP_SCHEMA_VERSION = 1;
const DATA_STORES = ['foods', 'meals', 'recipes', 'measurements', 'settings', 'apiCache'];
const PORTABLE_DATA_STORES = DATA_STORES.filter(name => name !== 'apiCache');
const MIGRATION_BACKUP_KEY = 'librelog_migration_backups';
const MAX_MIGRATION_BACKUPS = 3;
const SENSITIVE_SETTING_KEYS = new Set([
    'ai_api_key',
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

let dbInstance = null;

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

function filterSensitiveSettings(storeName, records) {
    return storeName === 'settings'
        ? records.filter(record => !SENSITIVE_SETTING_KEYS.has(record.key))
        : records;
}

function filterPortableExportRecords(storeName, records) {
    return filterSensitiveSettings(storeName, records)
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
            exportedStores[name] = filterSensitiveSettings(name, request.result);
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
                onComplete();
            } catch {
                fail();
            }
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

        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            const transaction = e.target.transaction;
            if (e.oldVersion === 0) {
                createStoresAndIndexes(db, transaction);
                return;
            }
            captureMigrationBackup(db, transaction, e.oldVersion, () => {
                createStoresAndIndexes(db, transaction);
            });
        };

        req.onsuccess = (e) => {
            dbInstance = e.target.result;
            resolve(dbInstance);
        };

        req.onerror = (e) => reject(e.target.error);
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
export async function put(storeName, data) {
    const store = await getStore(storeName, 'readwrite');
    const timestamp = now();
    const record = {
        ...data,
        id: data.id || uuid(),
        createdAt: data.createdAt || timestamp,
        updatedAt: timestamp,
        deleted: false,
    };
    await promisifyRequest(store.put(record));
    return record;
}

/**
 * Insert or update multiple records in a transaction
 * @param {string} storeName
 * @param {Array<Object>} items
 * @returns {Promise<Array>}
 */
export async function putMany(storeName, items) {
    const db = await openDB();
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const timestamp = now();
    const records = [];
    for (const data of items) {
        const record = {
            ...data,
            id: data.id || uuid(),
            createdAt: data.createdAt || timestamp,
            updatedAt: timestamp,
            deleted: data.deleted || false,
        };
        store.put(record);
        records.push(record);
    }
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(records);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Soft-delete a record (mark deleted=true)
 * @param {string} storeName
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function softDelete(storeName, id) {
    const store = await getStore(storeName, 'readwrite');
    const item = await promisifyRequest(store.get(id));
    if (item) {
        item.deleted = true;
        item.updatedAt = now();
        await promisifyRequest(store.put(item));
    }
}

/**
 * Hard-delete all records in a store (irreversible)
 * @param {string} storeName
 * @returns {Promise<void>}
 */
export async function hardDeleteAll(storeName) {
    const store = await getStore(storeName, 'readwrite');
    await promisifyRequest(store.clear());
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
export async function setSetting(key, value) {
    const store = await getStore('settings', 'readwrite');
    await promisifyRequest(store.put({ key, value, updatedAt: now() }));
}

// ---- Export / Import ----

/**
 * Export all data from all stores
 * @returns {Promise<Object>}
 */
export async function exportAllData() {
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
    const reads = stores.map(async name => {
        const records = await promisifyRequest(transaction.objectStore(name).getAll());
        return [name, filterPortableExportRecords(name, records)];
    });
    for (const [name, records] of await Promise.all(reads)) data.stores[name] = records;
    return data;
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
    if (value != null && !Number.isFinite(Number(value))) {
        throw new Error(`Backup ${label} must be a number or null`);
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
    if (item.nutrients != null) validateNutrients(item.nutrients, `${label} item`);
}

function validateStoreRecord(name, record) {
    if (name === 'settings') {
        if (typeof record.key !== 'string' || !record.key) {
            throw new Error('Backup contains a setting without a valid key');
        }
        return;
    }
    if (typeof record.id !== 'string' || !record.id) {
        throw new Error(`Backup store "${name}" contains a record without a valid id`);
    }

    if (name === 'foods') {
        if (typeof record.name !== 'string' || !record.name.trim()) {
            throw new Error('Backup food requires a name');
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

/**
 * Import all data into stores
 * @param {Object} data - exported data object
 * @param {boolean} merge - if false, clears stores first
 * @returns {Promise<void>}
 */
export async function importAllData(data, merge = false) {
    const stores = validateBackupData(data);
    const db = await openDB();

    // Credentials never leave the device in exports and must survive a replace
    // restore. Read them before the all-store transaction begins.
    const preservedSettings = new Map();
    if (!merge && stores.includes('settings')) {
        for (const key of SENSITIVE_SETTING_KEYS) {
            const value = await getSetting(key, undefined);
            if (value !== undefined && value !== null && value !== '') {
                preservedSettings.set(key, value);
            }
        }
    }

    const transactionStores = !merge && db.objectStoreNames.contains('apiCache')
        ? [...stores, 'apiCache']
        : stores;

    await new Promise((resolve, reject) => {
        const tx = db.transaction(transactionStores, 'readwrite');

        try {
            for (const name of stores) {
                const store = tx.objectStore(name);
                if (!merge) store.clear();
                for (const record of data.stores[name]) {
                    if (name === 'settings' && SENSITIVE_SETTING_KEYS.has(record.key)) continue;
                    if (record.deleted === true) continue;
                    const copy = structuredClone(record);
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

            if (!merge && transactionStores.includes('apiCache')) {
                tx.objectStore('apiCache').clear();
            }

            if (!merge && stores.includes('settings')) {
                const settingsStore = tx.objectStore('settings');
                for (const [key, value] of preservedSettings) {
                    settingsStore.put({ key, value, updatedAt: now() });
                }
            }
        } catch (error) {
            tx.abort();
            reject(error);
            return;
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Import transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('Import transaction was aborted'));
    });
}

/**
 * Clear all data from all stores
 * @returns {Promise<void>}
 */
export async function clearAllData() {
    for (const name of DATA_STORES) {
        await hardDeleteAll(name);
    }
    clearMigrationBackups();
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
