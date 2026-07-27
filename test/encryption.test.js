import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
} from '../src/data/encryption.js';

const backup = {
  version: 1,
  dataVersion: 2,
  stores: {
    meals: [{ id: 'private-meal', notes: 'private meal description' }],
  },
};

test('encrypted backups make an authenticated round trip', async () => {
  const encrypted = await encryptBackup(backup, 'correct horse battery staple');
  assert.equal(isEncryptedBackup(encrypted), true);
  assert.deepEqual(await decryptBackup(encrypted, 'correct horse battery staple'), backup);
  assert.equal(JSON.stringify(encrypted).includes('private meal description'), false);
});

test('encrypted backups reject a wrong passphrase and malformed data', async () => {
  const encrypted = await encryptBackup(backup, 'correct horse battery staple');
  await assert.rejects(
    decryptBackup(encrypted, 'incorrect passphrase'),
    /incorrect|damaged/i,
  );
  await assert.rejects(
    decryptBackup({ ...encrypted, iv: 'not base64' }, 'correct horse battery staple'),
    /invalid binary data/i,
  );
  await assert.rejects(
    encryptBackup(backup, 'short'),
    /at least 8/i,
  );
});
