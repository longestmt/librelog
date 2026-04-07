/**
 * state.js — Simple pub/sub reactive state for LibreLog
 */

const listeners = new Map();
const state = {};

/**
 * Get a state value by key
 * @param {string} key
 * @returns {any}
 */
export function getState(key) {
    return state[key];
}

/**
 * Set a state value and notify all subscribers
 * @param {string} key
 * @param {any} value
 */
export function setState(key, value) {
    state[key] = value;
    const subs = listeners.get(key);
    if (subs) {
        subs.forEach(fn => {
            try { fn(value); } catch (e) { console.error(`State listener error [${key}]:`, e); }
        });
    }
}

/**
 * Subscribe to state changes
 * @param {string} key
 * @param {Function} fn - callback(newValue)
 * @returns {Function} - unsubscribe function
 */
export function subscribe(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    // Return unsubscribe function
    return () => listeners.get(key)?.delete(fn);
}

/**
 * Update state with updater function
 * @param {string} key
 * @param {Function} updater - function(current) => newValue
 */
export function updateState(key, updater) {
    const current = state[key];
    setState(key, updater(current));
}
