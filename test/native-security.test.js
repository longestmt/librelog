import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the native release configuration does not allow cleartext traffic', async () => {
  const config = JSON.parse(
    await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'),
  );
  assert.notEqual(config.server?.cleartext, true);
});
