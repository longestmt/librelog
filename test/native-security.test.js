import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the native release configuration does not allow cleartext traffic', async () => {
  const config = JSON.parse(
    await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'),
  );
  assert.notEqual(config.server?.cleartext, true);
});

test('native projects declare required private capabilities', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const androidManifest = await readFile(
    new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url),
    'utf8',
  );
  const iosInfo = await readFile(
    new URL('../ios/App/App/Info.plist', import.meta.url),
    'utf8',
  );

  assert.ok(packageJson.dependencies['@capacitor/filesystem']);
  assert.ok(packageJson.dependencies['@capacitor/android']);
  assert.ok(packageJson.dependencies['@capacitor/ios']);
  assert.match(androidManifest, /android:allowBackup="false"/);
  assert.match(androidManifest, /android\.permission\.CAMERA/);
  assert.match(androidManifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(iosInfo, /NSCameraUsageDescription/);
  assert.match(iosInfo, /NSMicrophoneUsageDescription/);
});
