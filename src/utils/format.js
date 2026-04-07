/**
 * format.js — Formatting utilities for LibreLog
 * Handles dates, numbers, calories, macros, and percentages
 */

/**
 * Format a date string as "Mon, Apr 6"
 * @param {string} dateStr - ISO date string (YYYY-MM-DD) or Date object
 * @returns {string}
 */
export function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Format a date string as "Monday, April 6, 2026"
 * @param {string} dateStr - ISO date string (YYYY-MM-DD) or Date object
 * @returns {string}
 */
export function formatDateFull(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Format a number with locale-aware thousands separator
 * @param {number} n
 * @param {number} decimals - default 0
 * @returns {string}
 */
export function formatNumber(n, decimals = 0) {
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    }).format(n);
}

/**
 * Format calories: "1,450 kcal"
 * @param {number} kcal
 * @returns {string}
 */
export function formatCalories(kcal) {
    return `${formatNumber(Math.round(kcal))} kcal`;
}

/**
 * Format macronutrient: "145g protein"
 * @param {number} grams
 * @param {string} label - e.g. "protein", "carbs", "fat"
 * @returns {string}
 */
export function formatMacro(grams, label) {
    return `${formatNumber(Math.round(grams))}g ${label}`;
}

/**
 * Format percentage: "72%"
 * @param {number} current
 * @param {number} target
 * @returns {string}
 */
export function formatPercent(current, target) {
    if (target === 0) return '0%';
    const percent = Math.round((current / target) * 100);
    return `${percent}%`;
}

/**
 * Get today's date as YYYY-MM-DD string
 * @returns {string}
 */
export function todayStr() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Check if a date string is today
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {boolean}
 */
export function isToday(dateStr) {
    return dateStr === todayStr();
}

/**
 * Format time string: "9:30 AM" from "09:30"
 * @param {string} timeStr - HH:MM format
 * @returns {string}
 */
export function formatTime(timeStr) {
    if (!timeStr || !timeStr.includes(':')) return timeStr;
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = new Date(2000, 0, 1, hours, minutes);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
