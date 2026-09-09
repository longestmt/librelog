/**
 * webdav.js — WebDAV Sync for LibreLog
 * Saves/restores full app data to a private WebDAV folder (e.g. Nextcloud)
 * Backup file: librelog_backup.json
 * Excludes WebDAV/GitHub credentials from backups
 */

import { exportAllData } from './db.js';
import { getSetting, setSetting } from './db.js';
import { replaceAllDataWithSafetyBackup } from './auto-backup.js';
import { Capacitor } from '@capacitor/core';
import { getCredential, removeCredential, setCredential } from './credentials.js';
import { decryptBackup, encryptBackup, isEncryptedBackup } from './encryption.js';
import { getDataLockManager, withDataLifecycleLock } from './operation-locks.js';
import { hasRemoteProviderConsent } from '../integrations/privacy.js';

const REQUEST_TIMEOUT_MS = 15_000;
export const WEBDAV_CONFIG_LOCK_NAME = 'librelog:webdav-config:v1';

export async function withWebDavConfigLock(
    operation,
    lockManager = globalThis.navigator?.locks,
) {
    if (typeof operation !== 'function') throw new TypeError('A WebDAV configuration operation is required');
    return getDataLockManager(lockManager)
        .request(WEBDAV_CONFIG_LOCK_NAME, { mode: 'exclusive' }, operation);
}

async function requireWebDavConsent() {
    if (await hasRemoteProviderConsent('webdav')) return;
    const error = new Error('Confirm WebDAV remote data use in Settings before connecting.');
    error.code = 'consent-required';
    throw error;
}

async function browserFetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Get WebDAV configuration
 * @returns {Promise<{url: string|null, username: string|null, password: string|null, active: boolean}>}
 */
export async function getWebDavConfig({
    readSetting = getSetting,
    readCredential = getCredential,
    lockManager = globalThis.navigator?.locks,
} = {}) {
    return withWebDavConfigLock(async () => {
        const [active, url, username, password, legacyUrl, legacyUsername] = await Promise.all([
            readSetting('webdav_connected', false),
            readSetting('webdavUrl', null),
            readSetting('webdavUsername', null),
            readCredential('webdavPassword'),
            readSetting('webdav_url', null),
            readSetting('webdav_username', null),
        ]);
        const storedUrl = url || legacyUrl || null;
        let requestUrl = storedUrl;
        let transportSafe = false;
        if (storedUrl) {
            try {
                requestUrl = normalizeWebDavUrl(storedUrl);
                transportSafe = true;
            } catch {
                // Keep the unsafe legacy value visible in Settings for repair,
                // but never mark it usable by a network operation.
            }
        }
        // Preserve discoverability of pre-0.4 and interrupted configuration
        // tuples so Settings can recover them. Network operations still require
        // the separately committed active marker below.
        return {
            url: requestUrl,
            username: username || legacyUsername || null,
            password: password || null,
            active: active === true && transportSafe,
        };
    }, lockManager);
}

function normalizeWebDavUrl(value) {
    let parsed;
    try {
        parsed = new URL(String(value || '').trim());
    } catch {
        throw new Error('WebDAV URL must be a valid HTTPS URL.');
    }
    if (parsed.username || parsed.password) {
        throw new Error('Put WebDAV credentials in the username and password fields, not the URL.');
    }
    const loopback = parsed.hostname === 'localhost'
        || parsed.hostname === '[::1]'
        || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        throw new Error('WebDAV requires HTTPS. Plain HTTP is allowed only for localhost.');
    }
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed.toString();
}

/**
 * Store the multi-record connection tuple fail closed. Readers require the
 * active marker, which is cleared before any component changes and restored
 * only after all components have committed.
 */
export async function saveWebDavConfigSafely({ url, username, password }, {
    writeSetting = setSetting,
    writeCredential = setCredential,
    lockManager = globalThis.navigator?.locks,
} = {}) {
    return withWebDavConfigLock(async () => {
        await writeSetting('webdav_connected', false);
        await writeCredential('webdavPassword', password);
        await writeSetting('webdavUsername', username);
        await writeSetting('webdavUrl', url);
        // Remove keys written by the earlier, incompatible settings UI.
        await writeSetting('webdav_url', null);
        await writeSetting('webdav_username', null);
        await writeSetting('webdav_connected', true);
    }, lockManager);
}

/**
 * Set and validate WebDAV configuration
 * @param {string} url
 * @param {string} username
 * @param {string} password
 * @returns {Promise<void>}
 */
async function setWebDavConfigWithLifecycleLockHeld(url, username, password, {
    confirmRemoteDataUse = false,
    lockManager,
} = {}) {
    if (confirmRemoteDataUse) await setSetting('privacyConsent_webdav', true);
    else await requireWebDavConsent();
    if (!url || !username || !password) {
        throw new Error('WebDAV URL, username, and app password are required.');
    }
    url = normalizeWebDavUrl(url);

    // Test the connection before saving
    let res;
    try {
        const options = {
            url,
            method: 'PROPFIND',
            headers: {
                'Authorization': getAuthHeader(username, password),
                'Depth': '0'
            }
        };

        if (Capacitor.isNativePlatform() && Capacitor.Plugins.CapacitorHttp) {
            res = await Capacitor.Plugins.CapacitorHttp.request(options);
            res.ok = res.status >= 200 && res.status < 300;
        } else {
            res = await browserFetchWithTimeout(options.url, options);
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error('WebDAV request timed out after 15 seconds.');
        }
        if (e.message && e.message.includes('Failed to fetch')) {
            throw new Error('Network Error (CORS, Mixed Content, or invalid SSL). Check browser console.');
        }
        throw new Error(`Failed to connect to server: ${e.message}`);
    }

    if (!res.ok) {
        console.error('WebDAV fetch failed:', res);
        if (res.status === 401) {
            throw new Error('Invalid username or app password (401 Unauthorized). WebDAV usernames can be case-sensitive; check the capitalization and re-enter the app password.');
        }
        if (res.status === 404) throw new Error('WebDAV endpoint not found (404). Check the URL path.');
        throw new Error(`WebDAV Server Error: ${res.status} ${res.statusText || res.status}`);
    }

    await saveWebDavConfigSafely({ url, username, password }, { lockManager });
}

export async function setWebDavConfig(url, username, password, options = {}) {
    return withDataLifecycleLock(
        () => setWebDavConfigWithLifecycleLockHeld(url, username, password, options),
        options.lockManager,
    );
}

/** Revalidate and activate a complete tuple written by an earlier release. */
export async function activateStoredWebDavConfig({
    confirmRemoteDataUse = false,
    lockManager,
} = {}) {
    return withDataLifecycleLock(async () => {
        const config = await getWebDavConfig({ lockManager });
        if (!config.url || !config.username || !config.password) {
            throw new Error('Unlock credentials or reconnect WebDAV before enabling backups.');
        }
        return setWebDavConfigWithLifecycleLockHeld(config.url, config.username, config.password, {
            confirmRemoteDataUse,
            lockManager,
        });
    }, lockManager);
}

/**
 * Disconnect WebDAV (clear credentials)
 * @returns {Promise<void>}
 */
export async function disconnectWebDav({ lockManager } = {}) {
    return withDataLifecycleLock(() => withWebDavConfigLock(async () => {
        // The active marker is cleared first so any later failure stays safe.
        await setSetting('webdav_connected', false);
        await setSetting('privacyConsent_webdav', false);
        await setSetting('webdavUrl', null);
        await setSetting('webdavUsername', null);
        await removeCredential('webdavPassword');
        await setSetting('webdav_url', null);
        await setSetting('webdav_username', null);
    }, lockManager), lockManager);
}

/**
 * Generate Basic Auth header
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
function getAuthHeader(username, password) {
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
}

/**
 * Push backup to WebDAV server
 * Excludes webdav/github credentials from backup
 * @returns {Promise<boolean>}
 */
async function pushToWebDavWithLifecycleLockHeld({ passphrase, lifecycleToken, lockManager }) {
    await requireWebDavConsent();
    const config = await getWebDavConfig({ lockManager });
    if (config.active !== true || !config.url || !config.username || !config.password) {
        throw new Error('WebDAV is not fully configured.');
    }

    const data = await exportAllData({ lifecycleToken });
    // Exclude the credentials themselves from the backup file
    if (data.stores && data.stores.settings) {
        data.stores.settings = data.stores.settings.filter(s =>
            !['webdavUrl', 'webdavUsername', 'webdavPassword', 'githubPAT', 'githubGistId'].includes(s.key)
        );
    }

    const backup = passphrase ? await encryptBackup(data, passphrase) : data;
    const jsonStr = JSON.stringify(backup, null, 2);
    const requestBaseUrl = normalizeWebDavUrl(config.url);
    const targetUrl = `${requestBaseUrl}${passphrase ? 'librelog_backup.encrypted.json' : 'librelog_backup.json'}`;

    let res;
    try {
        const options = {
            url: targetUrl,
            method: 'PUT',
            headers: {
                'Authorization': getAuthHeader(config.username, config.password),
                'Content-Type': 'application/json'
            },
            data: jsonStr
        };

        if (Capacitor.isNativePlatform() && Capacitor.Plugins.CapacitorHttp) {
            res = await Capacitor.Plugins.CapacitorHttp.request(options);
            res.ok = res.status >= 200 && res.status < 300;
        } else {
            res = await browserFetchWithTimeout(options.url, { ...options, body: options.data });
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error('WebDAV request timed out after 15 seconds.');
        }
        if (e.message && e.message.includes('Failed to fetch')) {
            throw new Error('Network Error (CORS, Mixed Content, or invalid SSL). Check browser console.');
        }
        throw e;
    }

    if (!res.ok) {
        throw new Error(`WebDAV HTTP Error: ${res.status} ${res.statusText || res.status}`);
    }

    return true;
}

export async function pushToWebDav({ passphrase = null, lockManager } = {}) {
    return withDataLifecycleLock(
        lifecycleToken => pushToWebDavWithLifecycleLockHeld({ passphrase, lifecycleToken, lockManager }),
        lockManager,
    );
}

/**
 * Pull backup from WebDAV server
 * Restores credentials that are excluded from backup
 * @returns {Promise<boolean>}
 */
async function pullFromWebDavWithLifecycleLockHeld({ passphrase, lifecycleToken, lockManager }) {
    await requireWebDavConsent();
    const config = await getWebDavConfig({ lockManager });
    if (config.active !== true || !config.url || !config.username || !config.password) {
        throw new Error('WebDAV is not fully configured.');
    }

    const requestBaseUrl = normalizeWebDavUrl(config.url);
    const targetUrl = `${requestBaseUrl}${passphrase ? 'librelog_backup.encrypted.json' : 'librelog_backup.json'}`;

    let res;
    try {
        const options = {
            url: targetUrl,
            method: 'GET',
            headers: {
                'Authorization': getAuthHeader(config.username, config.password),
                'Accept': 'application/json',
                'Cache-Control': 'no-store'
            }
        };

        if (Capacitor.isNativePlatform() && Capacitor.Plugins.CapacitorHttp) {
            res = await Capacitor.Plugins.CapacitorHttp.request(options);
            res.ok = res.status >= 200 && res.status < 300;
        } else {
            // Omit Cache-Control header to avoid CORS preflight rejection;
            // fetch's cache option handles this instead.
            const { 'Cache-Control': _, ...browserHeaders } = options.headers;
            res = await browserFetchWithTimeout(options.url, {
                method: options.method,
                headers: browserHeaders,
                cache: 'no-store'
            });
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error('WebDAV request timed out after 15 seconds.');
        }
        if (e.message && e.message.includes('Failed to fetch')) {
            throw new Error('Network Error (CORS, Mixed Content, or invalid SSL). Check browser console.');
        }
        throw e;
    }

    if (res.status === 404) {
        throw new Error('Backup file not found on the server. Try pushing first.');
    }

    if (!res.ok) {
        throw new Error(`WebDAV HTTP Error: ${res.status} ${res.statusText || res.status}`);
    }

    let parsedData;
    try {
        // CapacitorHttp parses JSON natively, fetch does not.
        const jsonData = (Capacitor.isNativePlatform() && Capacitor.Plugins.CapacitorHttp)
            ? res.data
            : await res.json();
        parsedData = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    } catch {
        throw new Error('Failed to parse the WebDAV backup file. It may be corrupted.');
    }

    if (isEncryptedBackup(parsedData)) {
        if (!passphrase) throw new Error('This WebDAV backup requires its passphrase.');
        parsedData = await decryptBackup(parsedData, passphrase);
    }

    // Never replace current records until a verified local recovery snapshot
    // exists. Both steps share the lifecycle lock held across this restore.
    await replaceAllDataWithSafetyBackup(parsedData, { lifecycleToken });

    return true;
}

export async function pullFromWebDav({ passphrase = null, lockManager } = {}) {
    return withDataLifecycleLock(
        lifecycleToken => pullFromWebDavWithLifecycleLockHeld({ passphrase, lifecycleToken, lockManager }),
        lockManager,
    );
}
