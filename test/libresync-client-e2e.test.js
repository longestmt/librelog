import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  ALL_SYNC_STORE_NAMES,
  MemorySecretStorage,
  installLibreSyncStores,
  waitForTransaction,
} from '@libresync/client';
import { MemoryRelay } from '@libresync/testkit';
import { createLibreLogSyncClient } from '../src/sync/service.js';
import { applyLibreLogMaterialized } from '../src/sync/domain-adapter.js';
import { SYNCED_DOMAIN_STORES, toSyncChange } from '../src/sync/policy.js';
import { captureLibreLogEntityContext } from '../src/sync/entity-context.js';
import { saveRecipeWithFoods } from '../src/data/recipe-commands.js';
import { updateMeasurement } from '../src/data/measurement-commands.js';

function request(value) {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

async function openProfileDatabase(label) {
  const name = `librelog-sync-e2e-${label}-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      for (const storeName of SYNCED_DOMAIN_STORES) {
        database.createObjectStore(storeName, {
          keyPath: storeName === 'settings' ? 'key' : 'id',
        });
      }
      installLibreSyncStores(database, opening.transaction);
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

class ClientMemoryTransport {
  constructor(relay, deviceId, serverUrl) {
    this.relay = relay;
    this.deviceId = deviceId;
    this.serverUrl = serverUrl;
    this.applicationId = 'org.libresuite.librelog';
  }

  session(authorization) {
    return {
      vaultId: authorization.vaultId,
      credential: authorization.credential,
      deviceId: this.deviceId,
      applicationId: this.applicationId,
    };
  }

  async createVault(input) {
    const result = await this.relay.createVault(input);
    return { vaultId: result.vaultId, credential: result.credential };
  }

  async consumeInvitation(input) {
    const result = await this.relay.consumeInvitation(input);
    return { vaultId: result.vaultId, credential: result.credential };
  }

  push(authorization, envelopes) {
    return this.relay.push(this.session(authorization), envelopes);
  }

  async pull(authorization, continuationToken, limit) {
    const page = await this.relay.pull(this.session(authorization), continuationToken, limit);
    return {
      envelopes: page.envelopes,
      continuationToken: page.continuation,
      hasMore: page.hasMore,
    };
  }

  async createInvitation(authorization, ttlSeconds) {
    const invitation = await this.relay.createInvitation(
      this.session(authorization),
      ttlSeconds == null ? undefined : ttlSeconds * 1000,
    );
    return {
      invitationToken: invitation.invitationToken,
      expiresAt: invitation.expiresAt,
    };
  }

  async listDevices(authorization) {
    const devices = await this.relay.listDevices(this.session(authorization));
    return devices.map(device => ({ ...device, current: device.deviceId === this.deviceId }));
  }

  revokeDevice(authorization, deviceId) {
    return this.relay.revokeDevice(this.session(authorization), deviceId);
  }

  deleteVault(authorization, confirmation) {
    return this.relay.deleteVault(this.session(authorization), confirmation);
  }
}

async function writeInitialRecords(database, records) {
  const stores = [...new Set(records.map(([storeName]) => storeName))];
  const transaction = database.transaction(stores, 'readwrite');
  const completion = waitForTransaction(transaction);
  for (const [storeName, record] of records) {
    transaction.objectStore(storeName).put(structuredClone(record));
  }
  await completion;
}

async function readAll(database, storeName) {
  return request(database.transaction(storeName).objectStore(storeName).getAll());
}

async function readLocalEntities(database) {
  const changes = [];
  for (const storeName of SYNCED_DOMAIN_STORES) {
    const records = await readAll(database, storeName);
    for (const record of records) {
      const change = toSyncChange(
        storeName,
        record,
        record.deleted === true ? 'delete' : 'put',
      );
      if (change) changes.push(change);
    }
  }
  return changes;
}

async function visibleRecord(database, storeName, id) {
  const record = await request(database.transaction(storeName).objectStore(storeName).get(id));
  return record?.deleted === true ? null : record;
}

async function localMutation(profile, changes) {
  const domainStores = [...new Set(changes.map(change => change.entityType))];
  const transaction = profile.database.transaction(
    [...new Set([...domainStores, ...ALL_SYNC_STORE_NAMES])],
    'readwrite',
  );
  const completion = waitForTransaction(transaction);
  try {
    for (const change of changes) {
      const store = transaction.objectStore(change.entityType);
      if (change.kind === 'put') {
        store.put(structuredClone(change.payload));
      } else {
        const old = await request(store.get(change.entityId));
        store.put(change.entityType === 'settings'
          ? { key: change.entityId, value: null, deleted: true }
          : { ...(old || {}), id: change.entityId, deleted: true });
      }
    }
    const result = await profile.client.recordLocalOperation({ transaction, changes });
    if (result) {
      applyLibreLogMaterialized({
        transaction,
        entities: result.projections,
        operation: result.operation,
        source: 'reconcile',
      });
    }
    await completion;
  } catch (error) {
    try { transaction.abort(); } catch { /* already closed */ }
    try { await completion; } catch { /* consume failure */ }
    throw error;
  }
}

async function outboxCount(database) {
  return request(database.transaction('libresync_outbox').objectStore('libresync_outbox').count());
}

async function recordEnvelopeOnly(profile, changes) {
  const transaction = profile.database.transaction(ALL_SYNC_STORE_NAMES, 'readwrite');
  const completion = waitForTransaction(transaction);
  try {
    await profile.client.recordLocalOperation({ transaction, changes });
    await completion;
  } catch (error) {
    try { transaction.abort(); } catch { /* already closed */ }
    try { await completion; } catch { /* consume failure */ }
    throw error;
  }
}

function food(id, name, extra = {}) {
  return {
    id,
    name,
    servingSize: { quantity: 1, unit: 'serving', aliases: [] },
    nutrients: {
      energy: { kcal: 111 },
      macros: { protein: { g: 2 }, carbs: { g: 3 }, fat: { g: 4 } },
      fiber: { g: 1 },
      sodium: { mg: 5 },
    },
    ...extra,
  };
}

function makeProfile(database, relay, deviceId, deviceLabel, backupCounter) {
  const client = createLibreLogSyncClient({
    database,
    deviceId,
    deviceLabel,
    secretStorage: new MemorySecretStorage(),
    transportFactory: serverUrl => new ClientMemoryTransport(relay, deviceId, serverUrl),
    readLocalEntities: () => readLocalEntities(database),
    createSafetyBackup: async () => {
      backupCounter.count += 1;
      return { verified: true };
    },
  });
  return { database, client, deviceId };
}

test('failed portable safety verification leaves the pairing invitation unused', async () => {
  const relay = new MemoryRelay();
  const [databaseA, databaseB] = await Promise.all([
    openProfileDatabase('backup-owner'),
    openProfileDatabase('backup-joiner'),
  ]);
  const ownerId = crypto.randomUUID();
  const joinerId = crypto.randomUUID();
  const owner = makeProfile(databaseA, relay, ownerId, 'Owner', { count: 0 });
  await writeInitialRecords(databaseB, [['foods', food(crypto.randomUUID(), 'Pre-join local food')]]);

  let backupAttempts = 0;
  const joiner = createLibreLogSyncClient({
    database: databaseB,
    deviceId: joinerId,
    deviceLabel: 'Joiner',
    secretStorage: new MemorySecretStorage(),
    transportFactory: serverUrl => new ClientMemoryTransport(relay, joinerId, serverUrl),
    readLocalEntities: () => readLocalEntities(databaseB),
    createSafetyBackup: async () => {
      backupAttempts += 1;
      return { verified: backupAttempts > 1 };
    },
  });

  await owner.client.createVault({ serverUrl: 'http://localhost:8787', bootstrap: true });
  const invitation = await owner.client.createInvitation(600);
  await assert.rejects(
    joiner.joinVault(invitation.json),
    /portable safety backup could not be verified/i,
  );
  assert.equal((await joiner.getStatus()).connected, false);
  assert.equal((await owner.client.listDevices()).length, 1);

  // The exact same single-use invitation remains valid because backup
  // verification happens before the relay sees a consume request.
  await joiner.joinVault(invitation.json);
  assert.equal(backupAttempts, 2);
  assert.equal((await owner.client.listDevices()).length, 2);
});

test('encrypted malformed remote operations are quarantined without partial domain writes', async () => {
  const relay = new MemoryRelay();
  const [databaseA, databaseB] = await Promise.all([
    openProfileDatabase('invalid-author'),
    openProfileDatabase('invalid-receiver'),
  ]);
  const author = makeProfile(databaseA, relay, crypto.randomUUID(), 'Invalid author', { count: 0 });
  const receiver = makeProfile(databaseB, relay, crypto.randomUUID(), 'Receiver', { count: 0 });
  const connection = await author.client.createVault({
    serverUrl: 'http://localhost:8787',
    bootstrap: true,
  });
  const invitation = await author.client.createInvitation(600);
  await receiver.client.joinVault(invitation.json);

  await recordEnvelopeOnly(author, [{
    entityType: 'foods',
    entityId: 'malformed-food',
    kind: 'put',
    payload: { id: 'malformed-food', name: 'Encrypted malformed sentinel' },
  }]);
  await recordEnvelopeOnly(author, [
    toSyncChange('foods', food('atomic-valid-food', 'Must not partially materialize')),
    {
      entityType: 'meals',
      entityId: 'duplicate-child-meal',
      kind: 'put',
      payload: {
        id: 'duplicate-child-meal',
        date: '2026-09-01',
        type: 'lunch',
        items: [
          { itemId: 'same-child-id', foodId: 'atomic-valid-food', quantity: 1, unit: 'serving' },
          { itemId: 'same-child-id', foodId: 'atomic-valid-food', quantity: 2, unit: 'serving' },
        ],
      },
    },
  ]);

  await author.client.sync();
  const result = await receiver.client.sync();
  assert.equal(result.quarantined, 2);
  assert.equal((await receiver.client.getStatus()).quarantinedCount, 2);
  assert.equal(await visibleRecord(databaseB, 'foods', 'malformed-food'), undefined);
  assert.equal(await visibleRecord(databaseB, 'foods', 'atomic-valid-food'), undefined);
  assert.equal(await visibleRecord(databaseB, 'meals', 'duplicate-child-meal'), undefined);
  const relayBytes = relay.inspectVault(connection.vaultId).rawEnvelopeBytes.join('\n');
  assert.equal(relayBytes.includes('Encrypted malformed sentinel'), false);
  assert.equal(relayBytes.includes('Must not partially materialize'), false);
});

test('a pre-join local tombstone conflicts recoverably with a remote live value', async () => {
  const relay = new MemoryRelay();
  const [databaseA, databaseB] = await Promise.all([
    openProfileDatabase('prejoin-live'),
    openProfileDatabase('prejoin-delete'),
  ]);
  const profileA = makeProfile(databaseA, relay, crypto.randomUUID(), 'Live profile', { count: 0 });
  const profileB = makeProfile(databaseB, relay, crypto.randomUUID(), 'Deleted profile', { count: 0 });
  const entityId = crypto.randomUUID();
  await writeInitialRecords(databaseA, [['foods', food(entityId, 'Remote live food')]]);
  await writeInitialRecords(databaseB, [['foods', { id: entityId, deleted: true }]]);

  await profileA.client.createVault({ serverUrl: 'http://localhost:8787', bootstrap: true });
  await profileA.client.sync();
  const invitation = await profileA.client.createInvitation(600);
  await profileB.client.joinVault(invitation.json);

  const [conflict] = await profileB.client.listConflicts('foods');
  assert.equal(conflict.entityId, entityId);
  assert.equal(conflict.projection.kind, 'put', 'live value remains visible until resolution');
  assert.deepEqual(
    new Set(conflict.projection.alternatives.map(alternative => alternative.kind)),
    new Set(['put', 'delete']),
  );
  assert.equal((await visibleRecord(databaseB, 'foods', entityId)).name, 'Remote live food');
});

test('stale recipe and measurement forms cannot silently dominate an intervening pull', async () => {
  const relay = new MemoryRelay();
  const [databaseA, databaseB] = await Promise.all([
    openProfileDatabase('stale-form-a'),
    openProfileDatabase('stale-form-b'),
  ]);
  const profileA = makeProfile(databaseA, relay, crypto.randomUUID(), 'Stale form', { count: 0 });
  const profileB = makeProfile(databaseB, relay, crypto.randomUUID(), 'Remote editor', { count: 0 });
  const foodId = crypto.randomUUID();
  const recipeId = crypto.randomUUID();
  const measurementId = crypto.randomUUID();
  const baseRecipe = {
    id: recipeId,
    name: 'Original recipe',
    servings: 1,
    category: 'Original category',
    instructions: 'Original instructions',
    items: [{ itemId: crypto.randomUUID(), foodId, quantity: 1, unit: 'serving' }],
  };
  const baseMeasurement = {
    id: measurementId,
    date: '2026-09-01',
    weight: 80,
    unit: 'kg',
    bodyFat: 20,
  };
  await writeInitialRecords(databaseA, [
    ['foods', food(foodId, 'Stale form ingredient')],
    ['recipes', baseRecipe],
    ['measurements', baseMeasurement],
  ]);
  await profileA.client.createVault({ serverUrl: 'http://localhost:8787', bootstrap: true });
  await profileA.client.sync();
  const invitation = await profileA.client.createInvitation(600);
  await profileB.client.joinVault(invitation.json);

  const [recipeContext, measurementContext] = await Promise.all([
    captureLibreLogEntityContext('recipes', recipeId, databaseA),
    captureLibreLogEntityContext('measurements', measurementId, databaseA),
  ]);
  await localMutation(profileB, [
    toSyncChange('recipes', {
      ...baseRecipe,
      category: 'Remote category',
      remoteTag: 'must-survive-stale-save',
    }),
    toSyncChange('measurements', {
      ...baseMeasurement,
      note: 'remote measurement note',
    }),
  ]);
  await profileB.client.sync();
  await profileA.client.sync();

  await saveRecipeWithFoods({
    ...baseRecipe,
    name: 'User stale-form edit',
  }, [], { context: recipeContext, database: databaseA });
  await updateMeasurement(measurementId, {
    date: baseMeasurement.date,
    weight: 82,
    unit: 'kg',
    bodyFat: 20,
  }, {
    context: measurementContext,
    baseRecord: baseMeasurement,
    database: databaseA,
  });

  const [recipeConflict] = await profileA.client.listConflicts('recipes');
  const [measurementConflict] = await profileA.client.listConflicts('measurements');
  assert.equal(recipeConflict.entityId, recipeId);
  assert.equal(measurementConflict.entityId, measurementId);
  assert.equal(recipeConflict.projection.alternatives.length, 2);
  assert.equal(measurementConflict.projection.alternatives.length, 2);
  assert.equal(
    recipeConflict.projection.alternatives.every(alternative => (
      alternative.kind === 'put' && alternative.payload.remoteTag === 'must-survive-stale-save'
    )),
    true,
    'fresh unrelated recipe fields survive the scoped transaction merge',
  );
  assert.equal(
    measurementConflict.projection.alternatives.every(alternative => (
      alternative.kind === 'put' && alternative.payload.note === 'remote measurement note'
    )),
    true,
    'fresh unrelated measurement fields survive the scoped patch',
  );
});

test('two real LibreSync clients synchronize every LibreLog family and workflow without echo', async () => {
  const relay = new MemoryRelay();
  const [databaseA, databaseB] = await Promise.all([
    openProfileDatabase('a'),
    openProfileDatabase('b'),
  ]);
  const backupsA = { count: 0 };
  const backupsB = { count: 0 };
  const profileA = makeProfile(databaseA, relay, crypto.randomUUID(), 'Kitchen tablet', backupsA);
  const profileB = makeProfile(databaseB, relay, crypto.randomUUID(), 'Phone', backupsB);
  const seedId = 'librelog:food:seed:v1:sentinel-seed';
  const seedA = food(seedId, 'Sentinel seeded food', {
    source: { type: 'seed' },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  const seedB = {
    ...structuredClone(seedA),
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const mealId = crypto.randomUUID();
  const recipeId = crypto.randomUUID();
  const measurementA = crypto.randomUUID();
  const measurementB = crypto.randomUUID();
  const goals = {
    calorieTarget: 2100,
    proteinG: 140,
    carbG: 240,
    fatG: 70,
    fiberG: 31,
    sodiumMg: 2200,
  };
  const sharedSettings = [
    { key: 'nutritionGoals', value: goals },
    { key: 'theme', value: 'lauds' },
    { key: 'unit', value: 'metric' },
  ];
  await writeInitialRecords(databaseA, [
    ['foods', seedA],
    ['meals', {
      id: mealId,
      date: '2026-09-01',
      type: 'lunch',
      items: [{ itemId: crypto.randomUUID(), foodId: seedId, quantity: 1, unit: 'serving' }],
    }],
    ['recipes', {
      id: recipeId,
      name: 'Sentinel relay recipe',
      servings: 1,
      items: [{ itemId: crypto.randomUUID(), foodId: seedId, quantity: 1, unit: 'serving' }],
    }],
    ['measurements', { id: measurementA, date: '2026-09-01', weight: 80, unit: 'kg' }],
    ['settings', { key: 'note_2026-09-01', value: 'Sentinel private meal note' }],
    ['settings', {
      key: 'template_sentinel',
      value: {
        name: 'Sentinel meal template',
        items: [{ itemId: crypto.randomUUID(), foodId: seedId, quantity: 1, unit: 'serving' }],
      },
    }],
    ...sharedSettings.map(record => ['settings', { ...record, updatedAt: '2025-01-01' }]),
  ]);
  await writeInitialRecords(databaseB, [
    ['foods', seedB],
    ['measurements', { id: measurementB, date: '2026-09-01', weight: 81, unit: 'kg' }],
    ...sharedSettings.map(record => ['settings', { ...record, updatedAt: '2026-08-01' }]),
  ]);

  const connection = await profileA.client.createVault({
    serverUrl: 'http://localhost:8787',
    bootstrap: true,
  });
  await profileA.client.sync();
  const invitation = await profileA.client.createInvitation(600);
  assert.match(invitation.uri, /^libresync:/);
  await profileB.client.joinVault(invitation.json);
  assert.equal(backupsB.count, 1, 'join with local data verifies a safety backup');
  await profileA.client.sync();

  assert.equal((await profileB.client.getStatus()).conflictCount, 0, 'identical defaults adopt cleanly');
  assert.equal((await readAll(databaseB, 'foods')).filter(item => item.id === seedId).length, 1);
  assert.equal((await visibleRecord(databaseB, 'meals', mealId)).date, '2026-09-01');
  assert.equal((await visibleRecord(databaseB, 'recipes', recipeId)).name, 'Sentinel relay recipe');
  assert.equal((await readAll(databaseA, 'measurements')).filter(item => !item.deleted).length, 2);
  for (const key of ['nutritionGoals', 'theme', 'unit', 'note_2026-09-01', 'template_sentinel']) {
    assert.ok(await visibleRecord(databaseB, 'settings', key), key);
  }

  const relayBytes = relay.inspectVault(connection.vaultId).rawEnvelopeBytes.join('\n');
  for (const sentinel of [
    'Sentinel seeded food',
    'Sentinel relay recipe',
    'Sentinel private meal note',
    'Sentinel meal template',
  ]) {
    assert.equal(relayBytes.includes(sentinel), false, `${sentinel} remains encrypted`);
  }

  // Import-style atomic creation: the newly discovered food and referencing
  // meal travel as one operation, then appear together on the other profile.
  const importedFood = food(crypto.randomUUID(), 'Imported workflow food');
  const importedMeal = {
    id: crypto.randomUUID(),
    date: '2026-09-02',
    type: 'dinner',
    items: [{ itemId: crypto.randomUUID(), foodId: importedFood.id, quantity: 1, unit: 'serving' }],
  };
  await localMutation(profileA, [
    toSyncChange('foods', importedFood),
    toSyncChange('meals', importedMeal),
  ]);
  await profileA.client.sync();
  await profileB.client.sync();
  assert.ok(await visibleRecord(databaseB, 'foods', importedFood.id));
  assert.ok(await visibleRecord(databaseB, 'meals', importedMeal.id));
  assert.equal(await outboxCount(databaseB), 0, 'remote apply creates no outbox echo');

  // Update and copy workflows retain stable identities.
  const updatedFood = { ...(await visibleRecord(databaseB, 'foods', importedFood.id)), name: 'Updated workflow food' };
  await localMutation(profileB, [toSyncChange('foods', updatedFood)]);
  const copiedMeal = {
    ...(await visibleRecord(databaseB, 'meals', importedMeal.id)),
    id: crypto.randomUUID(),
    date: '2026-09-03',
    items: importedMeal.items.map(item => ({ ...item, itemId: crypto.randomUUID() })),
  };
  await localMutation(profileB, [toSyncChange('meals', copiedMeal)]);
  await profileB.client.sync();
  await profileA.client.sync();
  assert.equal((await visibleRecord(databaseA, 'foods', importedFood.id)).name, 'Updated workflow food');
  assert.ok(await visibleRecord(databaseA, 'meals', copiedMeal.id));

  // Restore-style diff: an approved setting update and a missing record
  // tombstone are one atomic causal change set.
  const restoredNote = { key: 'note_2026-09-01', value: 'Intentionally restored note' };
  await localMutation(profileA, [
    toSyncChange('settings', restoredNote),
    toSyncChange('meals', copiedMeal, 'delete'),
  ]);
  await profileA.client.sync();
  await profileB.client.sync();
  assert.equal((await visibleRecord(databaseB, 'settings', restoredNote.key)).value, restoredNote.value);
  assert.equal(await visibleRecord(databaseB, 'meals', copiedMeal.id), null);

  // Concurrent meal edits remain as one deterministic, recoverable conflict.
  const baseMealA = await visibleRecord(databaseA, 'meals', mealId);
  const baseMealB = await visibleRecord(databaseB, 'meals', mealId);
  const editA = { ...baseMealA, items: baseMealA.items.map(item => ({ ...item, quantity: 2 })) };
  const editB = { ...baseMealB, items: baseMealB.items.map(item => ({ ...item, quantity: 3 })) };
  await localMutation(profileA, [toSyncChange('meals', editA)]);
  await localMutation(profileB, [toSyncChange('meals', editB)]);
  await profileA.client.sync();
  await profileB.client.sync();
  await profileA.client.sync();
  const [mealConflictA] = await profileA.client.listConflicts('meals');
  const [mealConflictB] = await profileB.client.listConflicts('meals');
  assert.equal(mealConflictA.projection.alternatives.length, 2);
  assert.deepEqual(mealConflictA.projection, mealConflictB.projection);
  const mergedMeal = {
    ...structuredClone(mealConflictB.projection.payload),
    items: mealConflictB.projection.payload.items.map(item => ({ ...item, quantity: 4 })),
  };
  await profileB.client.resolveConflict('meals', mealId, { kind: 'put', payload: mergedMeal });
  await profileB.client.sync();
  await profileA.client.sync();
  assert.equal((await profileA.client.listConflicts('meals')).length, 0);
  assert.equal((await visibleRecord(databaseA, 'meals', mealId)).items[0].quantity, 4);

  // Concurrent delete versus live recipe edit retains both, materializes live,
  // and can be intentionally resolved as a deletion.
  const recipeA = await visibleRecord(databaseA, 'recipes', recipeId);
  const recipeB = await visibleRecord(databaseB, 'recipes', recipeId);
  await localMutation(profileA, [toSyncChange('recipes', recipeA, 'delete')]);
  await localMutation(profileB, [toSyncChange('recipes', { ...recipeB, name: 'Offline edited recipe' })]);
  await profileA.client.sync();
  await profileB.client.sync();
  await profileA.client.sync();
  const [recipeConflict] = await profileB.client.listConflicts('recipes');
  assert.equal(recipeConflict.projection.kind, 'put');
  assert.deepEqual(new Set(recipeConflict.projection.alternatives.map(item => item.kind)), new Set(['put', 'delete']));
  assert.ok(await visibleRecord(databaseB, 'recipes', recipeId));
  await profileB.client.resolveConflict('recipes', recipeId, { kind: 'delete' });
  await profileB.client.sync();
  await profileA.client.sync();
  assert.equal(await visibleRecord(databaseA, 'recipes', recipeId), null);

  const devices = await profileA.client.listDevices();
  assert.equal(devices.length, 2);
  assert.equal(devices.some(device => device.current), true);
  await profileA.client.revokeDevice(profileB.deviceId);
  await assert.rejects(() => profileB.client.sync(), /credential|unauthorized/i);

  await profileA.client.deleteVault(`delete:${connection.vaultId}`);
  assert.equal(relay.inspectVault(connection.vaultId), null);
  assert.ok(await visibleRecord(databaseA, 'foods', importedFood.id), 'vault deletion preserves local data');
});
