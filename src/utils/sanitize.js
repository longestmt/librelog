/**
 * sanitize.js — HTML escaping utility
 * Prevents XSS attacks by escaping user input
 */

/**
 * Escape HTML special characters
 * @param {*} str
 * @returns {string}
 */
export function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
