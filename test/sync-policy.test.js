import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSynchronizedEntity,
  isSyncedSettingKey,
  toSyncChange,
} from '../src/sync/policy.js';

test('LibreLog sync policy uses a positive settings allowlist', () => {
  for (const key of ['nutritionGoals', 'theme', 'unit', 'note_2026-09-01', 'template_abc']) {
    assert.equal(isSyncedSettingKey(key), true, key);
  }
  for (const key of [
    'newSettingAddedLater',
    'ai_api_key',
    'ai_provider',
    'ai_model',
    'ai_ollama_url',
    'ai_usage_log',
    'usda_api_key',
    'webdavPassword',
    'privacyConsent_usda',
    'initialized',
    'lastBackupTime',
    'credentialEncryptionVerifier',
    'libresync_deviceId',
  ]) {
    assert.equal(isSyncedSettingKey(key), false, key);
  }
});

test('domain mapping excludes cache and local settings', () => {
  assert.equal(isSynchronizedEntity('foods', 'food-1'), true);
  assert.equal(isSynchronizedEntity('apiCache', 'query'), false);
  assert.equal(toSyncChange('settings', { key: 'theme', value: 'lauds' }).entityId, 'theme');
  assert.equal(toSyncChange('settings', { key: 'ai_model', value: 'private-choice' }), null);
});

test('installation metadata cannot create false conflicts for defaults', () => {
  const firstSetting = toSyncChange('settings', {
    key: 'theme', value: 'lauds', updatedAt: '2026-01-01T00:00:00.000Z', deleted: false,
  });
  const secondSetting = toSyncChange('settings', {
    key: 'theme', value: 'lauds', updatedAt: '2026-09-01T00:00:00.000Z', deleted: false,
  });
  assert.deepEqual(firstSetting.payload, secondSetting.payload);

  const firstSeed = toSyncChange('foods', {
    id: 'librelog:food:seed:v1:egg-large',
    name: 'Egg, large',
    source: { type: 'seed' },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  const secondSeed = toSyncChange('foods', {
    id: 'librelog:food:seed:v1:egg-large',
    name: 'Egg, large',
    source: { type: 'seed' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(firstSeed.payload, secondSeed.payload);
});
