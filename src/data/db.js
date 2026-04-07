/**
 * db.js — IndexedDB wrapper for LibreLog
 * Every record: id (UUID), createdAt, updatedAt, deleted (soft-delete)
 * Stores: foods, meals, recipes, measurements, settings, apiCache
 */

const DB_NAME = 'librelog';
const DB_VERSION = 1;

let dbInstance = null;

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

            // Foods store
            if (!db.objectStoreNames.contains('foods')) {
                const store = db.createObjectStore('foods', { keyPath: 'id' });
                store.createIndex('name', 'name', { unique: false });
                store.createIndex('barcode', 'barcode', { unique: false });
                store.createIndex('source', 'source', { unique: false });
            }

            // Meals store
            if (!db.objectStoreNames.contains('meals')) {
                const store = db.createObjectStore('meals', { keyPath: 'id' });
                store.createIndex('date', 'date', { unique: false });
                store.createIndex('mealType', 'mealType', { unique: false });
            }

            // Recipes store
            if (!db.objectStoreNames.contains('recipes')) {
                const store = db.createObjectStore('recipes', { keyPath: 'id' });
                store.createIndex('name', 'name', { unique: false });
                store.createIndex('category', 'category', { unique: false });
            }

            // Measurements store (body weight, etc.)
            if (!db.objectStoreNames.contains('measurements')) {
                const store = db.createObjectStore('measurements', { keyPath: 'id' });
                store.createIndex('date', 'date', { unique: false });
            }

            // Settings (key-value)
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }

            // API Cache (for Open Food Facts, USDA, etc.)
            if (!db.objectStoreNames.contains('apiCache')) {
                const store = db.createObjectStore('apiCache', { keyPath: 'id' });
                store.createIndex('source', 'source', { unique: false });
                store.createIndex('query', 'query', { unique: false });
                store.createIndex('expiresAt', 'expiresAt', { unique: false });
            }
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
    const allStores = ['foods', 'meals', 'recipes', 'measurements', 'settings', 'apiCache'];
    const data = { version: DB_VERSION, exportedAt: now(), stores: {} };
    for (const name of allStores) {
        if (!db.objectStoreNames.contains(name)) continue;
        const store = await getStore(name);
        data.stores[name] = await promisifyRequest(store.getAll());
    }
    return data;
}

/**
 * Import all data into stores
 * @param {Object} data - exported data object
 * @param {boolean} merge - if false, clears stores first
 * @returns {Promise<void>}
 */
export async function importAllData(data, merge = false) {
    const stores = ['foods', 'meals', 'recipes', 'measurements', 'settings', 'apiCache'];
    for (const name of stores) {
        if (!data.stores[name]) continue;
        if (!merge) {
            await hardDeleteAll(name);
        }
        await putMany(name, data.stores[name]);
    }
}

/**
 * Clear all data from all stores
 * @returns {Promise<void>}
 */
export async function clearAllData() {
    const stores = ['foods', 'meals', 'recipes', 'measurements', 'settings', 'apiCache'];
    for (const name of stores) {
        await hardDeleteAll(name);
    }
}

export { uuid, now, openDB };
