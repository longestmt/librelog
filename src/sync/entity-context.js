import {
  contextForHeads,
  entityKey,
  headVersion,
  materializeEntity,
} from '@libresync/protocol';
import { requestToPromise, SYNC_STORE_NAMES, waitForTransaction } from '@libresync/client';
import { openDB } from '../data/db.js';

/**
 * Capture the causal version a form actually displayed. Passing this context
 * back with a later save makes an intervening remote head concurrent instead
 * of silently claiming that the stale form observed it.
 */
export async function captureLibreLogEntityContext(
  entityType,
  entityId,
  databaseProvider = openDB,
) {
  if (!entityId) return {};
  const database = typeof databaseProvider === 'function'
    ? await databaseProvider()
    : await databaseProvider;
  const transaction = database.transaction(SYNC_STORE_NAMES.entityHeads, 'readonly');
  const completion = waitForTransaction(transaction);
  const stored = await requestToPromise(
    transaction.objectStore(SYNC_STORE_NAMES.entityHeads).get(entityKey(entityType, entityId)),
  );
  await completion;
  if (!stored?.heads?.length) return {};
  const heads = {
    entityType: stored.entityType,
    entityId: stored.entityId,
    heads: structuredClone(stored.heads),
  };
  const projection = materializeEntity(heads);
  if (projection.conflicted) {
    const selected = projection.alternatives[0];
    return selected ? headVersion(selected) : {};
  }
  return contextForHeads(heads);
}
