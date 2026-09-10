import { requestToPromise, waitForTransaction } from '@libresync/client';
import { openDB } from '../data/db.js';
import {
  SYNCED_DOMAIN_STORES,
  toSyncChange,
} from './policy.js';
export { chunkLocalChanges, LOCAL_OPERATION_CHANGE_LIMIT } from './batching.js';

export async function readLibreLogLocalEntities() {
  const database = await openDB();
  const transaction = database.transaction(SYNCED_DOMAIN_STORES, 'readonly');
  const completion = waitForTransaction(transaction);
  const recordsByStore = await Promise.all(SYNCED_DOMAIN_STORES.map(async storeName => [
    storeName,
    await requestToPromise(transaction.objectStore(storeName).getAll()),
  ]));
  await completion;
  const changes = [];
  for (const [storeName, records] of recordsByStore) {
    for (const record of records) {
      const change = toSyncChange(storeName, record, record.deleted === true ? 'delete' : 'put');
      if (change) changes.push(change);
    }
  }
  return changes;
}

export async function readLibreLogDeleteChanges() {
  return (await readLibreLogLocalEntities()).map(({ payload, ...change }) => ({
    ...change,
    kind: 'delete',
  }));
}
