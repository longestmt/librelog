import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReplicaState,
  decryptEnvelope,
  encryptOperation,
  generateEncodedVaultSecret,
  reduceOperation,
} from '@libresync/protocol';
import {
  MemoryRelay,
  MemoryTransport,
  operationFixture,
} from '@libresync/testkit';
import {
  LIBRELOG_APP_ID,
  toSyncChange,
} from '../src/sync/policy.js';

const sentinel = 'LIBRELOG-PLAINTEXT-SENTINEL-7f9434';

function synchronizedChanges() {
  const records = [
    ['foods', { id: 'food-a', name: sentinel, servingSize: { quantity: 1, unit: 'serving' } }],
    ['meals', { id: 'meal-a', date: '2026-09-01', type: 'lunch', items: [{ itemId: 'item-a', foodId: 'food-a', quantity: 1, unit: 'serving' }] }],
    ['recipes', { id: 'recipe-a', name: 'Sentinel recipe', servings: 1, items: [{ itemId: 'ingredient-a', foodId: 'food-a', quantity: 1, unit: 'serving' }] }],
    ['measurements', { id: 'measurement-a', date: '2026-09-01', weight: 80, unit: 'kg' }],
    ['settings', { key: 'nutritionGoals', value: { calorieTarget: 2000 } }],
    ['settings', { key: 'theme', value: 'lauds' }],
    ['settings', { key: 'unit', value: 'metric' }],
    ['settings', { key: 'note_2026-09-01', value: 'Sentinel note' }],
    ['settings', { key: 'template_template-a', value: { name: 'Sentinel template', items: [] } }],
  ];
  return records.map(([store, record]) => ({ ...toSyncChange(store, record), context: {} }));
}

test('two LibreLog profiles relay every approved entity family as ciphertext', async () => {
  const relay = new MemoryRelay({ maxPageOperations: 2 });
  const first = new MemoryTransport(relay);
  const firstSession = await first.createVault({
    applicationId: LIBRELOG_APP_ID,
    deviceId: 'device-a',
    deviceLabel: 'First browser',
  });
  const invitation = await first.createInvitation();
  const second = new MemoryTransport(relay);
  await second.joinVault({
    vaultId: firstSession.vaultId,
    applicationId: LIBRELOG_APP_ID,
    invitationToken: invitation.invitationToken,
    deviceId: 'device-b',
    deviceLabel: 'Second browser',
  });

  const secret = generateEncodedVaultSecret();
  const operation = operationFixture({
    deviceId: 'device-a',
    counter: 1,
    opId: 'librelog-bootstrap-1',
    changes: synchronizedChanges(),
  });
  const envelope = await encryptOperation(operation, secret, {
    vaultId: firstSession.vaultId,
    applicationId: LIBRELOG_APP_ID,
  });
  await first.push([envelope]);

  const raw = relay.inspectVault(firstSession.vaultId).rawEnvelopeBytes.join('\n');
  assert.equal(raw.includes(sentinel), false);
  assert.equal(raw.includes('Sentinel recipe'), false);
  const page = await second.pull();
  const decrypted = await decryptEnvelope(page.envelopes[0], secret, {
    vaultId: firstSession.vaultId,
    applicationId: LIBRELOG_APP_ID,
  });
  const reduced = reduceOperation(createReplicaState(), decrypted);
  assert.equal(reduced.projections.length, synchronizedChanges().length);
  assert.deepEqual(
    new Set(reduced.projections.map(item => item.entityType)),
    new Set(['foods', 'meals', 'recipes', 'measurements', 'settings']),
  );
});

test('LibreLog concurrent meal edits remain recoverable and deterministic', () => {
  const base = operationFixture({
    deviceId: 'device-a',
    counter: 1,
    opId: 'base-meal-op',
    entityType: 'meals',
    entityId: 'meal-a',
    payload: { id: 'meal-a', note: 'base' },
  });
  const left = operationFixture({
    deviceId: 'device-a',
    counter: 2,
    opId: 'left-meal-op',
    entityType: 'meals',
    entityId: 'meal-a',
    context: { 'device-a': 1 },
    payload: { id: 'meal-a', note: 'left' },
    authoredAt: '2099-01-01T00:00:00.000Z',
  });
  const right = operationFixture({
    deviceId: 'device-b',
    counter: 1,
    opId: 'right-meal-op',
    entityType: 'meals',
    entityId: 'meal-a',
    context: { 'device-a': 1 },
    payload: { id: 'meal-a', note: 'right' },
    authoredAt: '1999-01-01T00:00:00.000Z',
  });
  let firstOrder = reduceOperation(createReplicaState(), base).state;
  firstOrder = reduceOperation(firstOrder, left).state;
  const firstResult = reduceOperation(firstOrder, right);
  let secondOrder = reduceOperation(createReplicaState(), base).state;
  secondOrder = reduceOperation(secondOrder, right).state;
  const secondResult = reduceOperation(secondOrder, left);

  assert.deepEqual(firstResult.state, secondResult.state);
  assert.equal(firstResult.projections[0].conflicted, true);
  assert.equal(firstResult.projections[0].alternatives.length, 2);
  assert.equal(firstResult.projections[0].payload.note, secondResult.projections[0].payload.note);
});

test('credentials and local-only settings cannot enter LibreLog operations', () => {
  for (const key of [
    'ai_api_key',
    'webdavPassword',
    'privacyConsent_usda',
    'ai_usage_log',
    'initialized',
    'libresync_deviceId',
  ]) {
    assert.equal(toSyncChange('settings', { key, value: sentinel }), null);
  }
  assert.equal(toSyncChange('apiCache', { id: 'private-query', query: sentinel }), null);
});
