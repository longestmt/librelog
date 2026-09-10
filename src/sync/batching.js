export const LOCAL_OPERATION_CHANGE_LIMIT = 200;

export function chunkLocalChanges(changes, size = LOCAL_OPERATION_CHANGE_LIMIT) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 256) {
    throw new Error('LibreSync change chunk size must be from 1 to 256');
  }
  const chunks = [];
  for (let index = 0; index < changes.length; index += size) {
    chunks.push(changes.slice(index, index + size));
  }
  return chunks;
}
