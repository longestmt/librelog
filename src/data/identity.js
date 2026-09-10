/**
 * Stable identity helpers used by IndexedDB migrations and new writes.
 *
 * These functions deliberately avoid timestamps and random input when repairing
 * legacy records. That lets independently-installed replicas arrive at the same
 * identity for built-in data and for children that already existed before sync.
 */

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}
export function stableHash(value) {
  const text = typeof value === 'string' ? value : canonicalize(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function normalizeSlug(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unnamed';
}

export function canonicalSeedFoodId(foodOrName) {
  const name = typeof foodOrName === 'string' ? foodOrName : foodOrName?.name;
  return `librelog:food:seed:v1:${normalizeSlug(name)}`;
}

export function newId() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('This browser does not provide secure UUID generation');
  }
  return globalThis.crypto.randomUUID();
}

function childFingerprint(item) {
  const copy = { ...item };
  delete copy.itemId;
  return copy;
}

export function deterministicItemId(parentId, item, index) {
  const digest = stableHash({ parentId, index, item: childFingerprint(item) });
  return `${parentId}:item:v1:${digest}`;
}

export function backfillItemIds(parentId, items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => ({
    ...item,
    itemId: typeof item?.itemId === 'string' && item.itemId
      ? item.itemId
      : deterministicItemId(parentId, item, index),
  }));
}

export function assignNewItemIds(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({ ...item, itemId: item?.itemId || newId() }));
}
