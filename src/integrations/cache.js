/**
 * API response caching layer using IndexedDB
 * Stores and retrieves cached API responses with TTL expiration
 */

import { put, getByIndex, softDelete, getAll } from '../data/db.js';

const STORE_NAME = 'apiCache';

/**
 * Generate cache key from source and query
 * @private
 * @param {string} source - API source identifier
 * @param {string} query - Search query or lookup identifier
 * @returns {string} Combined cache key
 */
function generateKey(source, query) {
  return `${source}:${query}`;
}

/**
 * Get cached data if available and not expired
 * @param {string} source - API source identifier (e.g., 'openfoodfacts')
 * @param {string} query - Search query or lookup identifier
 * @returns {Promise<Object|null>} Cached data or null if not found/expired
 */
async function getCached(source, query) {
  if (!source || !query) {
    return null;
  }

  try {
    const key = generateKey(source, query);

    // Use getAll and filter since 'key' is not an indexed field
    const allEntries = await getAll(STORE_NAME);
    const entry = allEntries?.find(e => e.key === key);

    if (!entry) {
      return null;
    }

    // Check if entry has expired
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      // Clean up expired entry asynchronously
      try {
        await softDelete(STORE_NAME, entry.id);
      } catch (error) {
        console.warn('Error cleaning up expired cache entry:', error);
      }
      return null;
    }

    return entry.data || null;
  } catch (error) {
    console.error('Error retrieving cached data:', error);
    return null;
  }
}

/**
 * Store data in cache with TTL expiration
 * @param {string} source - API source identifier
 * @param {string} query - Search query or lookup identifier
 * @param {Object} data - Data to cache
 * @param {number} ttlSeconds - Time to live in seconds
 * @returns {Promise<void>}
 */
async function setCache(source, query, data, ttlSeconds = 3600) {
  if (!source || !query || !data) {
    return;
  }

  try {
    const key = generateKey(source, query);
    const now = Date.now();
    const expiresAt = now + (ttlSeconds * 1000);

    const entry = {
      id: key,  // Use cache key as ID to prevent duplicates
      key,
      source,
      query,
      data,
      expiresAt,
      createdAt: now,
      isDeleted: false
    };

    await put(STORE_NAME, entry);
  } catch (error) {
    console.error('Error storing cache entry:', error);
  }
}

/**
 * Remove all expired cache entries
 * @returns {Promise<number>} Number of entries cleaned up
 */
async function clearExpired() {
  try {
    const allEntries = await getAll(STORE_NAME);

    if (!allEntries || allEntries.length === 0) {
      return 0;
    }

    const now = Date.now();
    let clearedCount = 0;

    for (const entry of allEntries) {
      // Skip already deleted entries
      if (entry.isDeleted) {
        continue;
      }

      // Check if expired
      if (entry.expiresAt && now > entry.expiresAt) {
        try {
          await softDelete(STORE_NAME, entry.id);
          clearedCount++;
        } catch (error) {
          console.warn('Error cleaning expired entry:', error);
        }
      }
    }

    return clearedCount;
  } catch (error) {
    console.error('Error clearing expired cache entries:', error);
    return 0;
  }
}

/**
 * Manually clear all cache entries for a specific source
 * @param {string} source - API source identifier
 * @returns {Promise<number>} Number of entries cleared
 */
async function clearSource(source) {
  if (!source) {
    return 0;
  }

  try {
    const entries = await getByIndex(STORE_NAME, 'source', source);

    if (!entries || entries.length === 0) {
      return 0;
    }

    let clearedCount = 0;

    for (const entry of entries) {
      if (!entry.isDeleted) {
        try {
          await softDelete(STORE_NAME, entry.id);
          clearedCount++;
        } catch (error) {
          console.warn('Error clearing cache entry:', error);
        }
      }
    }

    return clearedCount;
  } catch (error) {
    console.error('Error clearing cache for source:', error);
    return 0;
  }
}

/**
 * Clear all cache entries (hard delete)
 * @returns {Promise<void>}
 */
async function clearAll() {
  try {
    const allEntries = await getAll(STORE_NAME);

    if (!allEntries || allEntries.length === 0) {
      return;
    }

    for (const entry of allEntries) {
      try {
        await softDelete(STORE_NAME, entry.id);
      } catch (error) {
        console.warn('Error clearing cache entry:', error);
      }
    }
  } catch (error) {
    console.error('Error clearing all cache:', error);
  }
}

export {
  getCached,
  setCache,
  clearExpired,
  clearSource,
  clearAll
};
