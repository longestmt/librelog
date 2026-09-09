import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, getAll, put, setSetting } from '../src/data/db.js';
import { setCredential } from '../src/data/credentials.js';
import {
  activateStoredWebDavConfig,
  getWebDavConfig,
  pullFromWebDav,
  pushToWebDav,
  saveWebDavConfigSafely,
  setWebDavConfig,
} from '../src/data/webdav.js';

function serialLockManager() {
  let tail = Promise.resolve();
  return {
    request(_name, _options, operation) {
      const result = tail.then(() => operation());
      tail = result.catch(() => {});
      return result;
    },
  };
}

function memoryWebDavConfig({ failOn } = {}) {
  const state = new Map([
    ['webdav_connected', true],
    ['webdavUrl', 'https://old.example/dav/'],
    ['webdavUsername', 'old-user'],
    ['credential:webdavPassword', 'old-password'],
  ]);
  return {
    state,
    dependencies: {
      async readSetting(key, fallback = null) {
        return state.has(key) ? state.get(key) : fallback;
      },
      async writeSetting(key, value) {
        if (`setting:${key}` === failOn) throw new Error('simulated write failure');
        state.set(key, value);
      },
      async readCredential(name) {
        return state.get(`credential:${name}`) || null;
      },
      async writeCredential(name, value) {
        if (`credential:${name}` === failOn) throw new Error('simulated write failure');
        state.set(`credential:${name}`, value);
      },
    },
  };
}

function validFood(id, name) {
  return {
    id,
    name,
    servingSize: { quantity: 100, unit: 'g', aliases: [] },
    nutrients: {
      energy: { kcal: 100 },
      macros: { protein: { g: 1 }, carbs: { g: 2 }, fat: { g: 3 } },
      fiber: { g: null },
      sodium: { mg: null },
    },
  };
}

test('WebDAV networking requires local consent, including the first connection', async t => {
  await clearAllData();
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return new Response('', { status: 207 });
  });

  await assert.rejects(
    setWebDavConfig('https://example.invalid/dav/', 'user', 'password'),
    error => error.code === 'consent-required',
  );
  assert.equal(fetchCount, 0);

  await setSetting('privacyConsent_webdav', true);
  await setWebDavConfig('https://example.invalid/dav/', 'user', 'password');
  assert.equal(fetchCount, 1);
  assert.deepEqual(await getWebDavConfig(), {
    url: 'https://example.invalid/dav/',
    username: 'user',
    password: 'password',
    active: true,
  });

  await setSetting('privacyConsent_webdav', false);
  await assert.rejects(pushToWebDav(), error => error.code === 'consent-required');
  await assert.rejects(pullFromWebDav(), error => error.code === 'consent-required');
  assert.equal(fetchCount, 1);
});

test('WebDAV Basic auth preserves mixed-case usernames and UTF-8 credentials', async t => {
  await clearAllData();
  await setSetting('privacyConsent_webdav', true);
  let authorization = null;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    authorization = options.headers.Authorization;
    return new Response('', { status: 207 });
  });

  const username = 'LibreLift';
  const password = 'pässword';
  await setWebDavConfig('https://example.invalid/dav/', username, password);

  assert.equal(
    authorization,
    `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
  );
  assert.deepEqual(await getWebDavConfig(), {
    url: 'https://example.invalid/dav/',
    username,
    password,
    active: true,
  });
});

test('WebDAV passwords retain surrounding whitespace after validation and storage', async t => {
  await clearAllData();
  await setSetting('privacyConsent_webdav', true);
  let authorization = null;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    authorization = options.headers.Authorization;
    return new Response('', { status: 207 });
  });

  const username = 'LibreLift';
  const password = ' app-password ';
  await setWebDavConfig('https://example.invalid/dav/', username, password);

  assert.equal(
    authorization,
    `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
  );
  assert.equal((await getWebDavConfig()).password, password);
});

test('WebDAV 401 errors prompt credential case and app-password checks', async t => {
  await clearAllData();
  await setSetting('privacyConsent_webdav', true);
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));

  await assert.rejects(
    setWebDavConfig('https://example.invalid/dav/', 'LibreLift', 'app-password'),
    error => /case-sensitive/i.test(error.message) && /re-enter the app password/i.test(error.message),
  );
});

test('WebDAV tuple updates fail closed when a component write fails', async () => {
  const memory = memoryWebDavConfig({ failOn: 'setting:webdavUrl' });
  const locks = serialLockManager();
  await assert.rejects(saveWebDavConfigSafely({
    url: 'https://new.example/dav/',
    username: 'new-user',
    password: 'new-password',
  }, { ...memory.dependencies, lockManager: locks }));

  assert.equal(memory.state.get('webdav_connected'), false);
  assert.deepEqual(await getWebDavConfig({
    ...memory.dependencies,
    lockManager: locks,
  }), {
    url: 'https://old.example/dav/',
    username: 'new-user',
    password: 'new-password',
    active: false,
  });
});

test('concurrent WebDAV tuple updates cannot cross their credentials', async () => {
  const memory = memoryWebDavConfig();
  const locks = serialLockManager();
  const dependencies = { ...memory.dependencies, lockManager: locks };

  await Promise.all([
    saveWebDavConfigSafely({
      url: 'https://first.example/dav/',
      username: 'first-user',
      password: 'first-password',
    }, dependencies),
    saveWebDavConfigSafely({
      url: 'https://second.example/dav/',
      username: 'second-user',
      password: 'second-password',
    }, dependencies),
  ]);

  assert.deepEqual(await getWebDavConfig({ ...memory.dependencies, lockManager: locks }), {
    url: 'https://second.example/dav/',
    username: 'second-user',
    password: 'second-password',
    active: true,
  });
});

test('legacy WebDAV settings remain recoverable but cannot access the network before activation', async t => {
  await clearAllData();
  await setSetting('privacyConsent_webdav', true);
  await setSetting('webdav_url', 'https://legacy.example/dav');
  await setSetting('webdav_username', 'legacy-user');
  await setCredential('webdavPassword', 'legacy-password');
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return new Response('', { status: 207 });
  });

  assert.deepEqual(await getWebDavConfig(), {
    url: 'https://legacy.example/dav/',
    username: 'legacy-user',
    password: 'legacy-password',
    active: false,
  });
  await assert.rejects(pushToWebDav(), /not fully configured/i);
  assert.equal(fetchCount, 0);

  await activateStoredWebDavConfig({ confirmRemoteDataUse: true });
  assert.equal(fetchCount, 1);
  assert.equal((await getWebDavConfig()).active, true);
});

test('WebDAV never sends credentials over non-loopback HTTP, including legacy active settings', async t => {
  await clearAllData();
  await setSetting('privacyConsent_webdav', true);
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return new Response('', { status: 207 });
  });

  await assert.rejects(
    setWebDavConfig('http://webdav.example/dav/', 'user', 'password'),
    /requires HTTPS/i,
  );
  assert.equal(fetchCount, 0);

  await setSetting('webdav_connected', true);
  await setSetting('webdavUrl', 'http://webdav.example/dav/');
  await setSetting('webdavUsername', 'legacy-user');
  await setCredential('webdavPassword', 'legacy-password');
  assert.equal((await getWebDavConfig()).active, false);
  await assert.rejects(pushToWebDav(), /not fully configured/i);
  assert.equal(fetchCount, 0);

  await setWebDavConfig('http://127.0.0.1:8080/dav', 'local-user', 'local-password');
  assert.equal(fetchCount, 1);
  assert.equal((await getWebDavConfig()).active, true);
});

test('WebDAV restore leaves current data untouched if its safety backup fails', async t => {
  await clearAllData();
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() { throw new Error('Quota exceeded'); },
    removeItem() {},
  };
  await setSetting('privacyConsent_webdav', true);
  await setSetting('webdav_connected', true);
  await setSetting('webdavUrl', 'https://example.invalid/dav/');
  await setSetting('webdavUsername', 'user');
  await setCredential('webdavPassword', 'password');
  await put('foods', validFood('local-food', 'Local food'));

  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    version: 1,
    stores: {
      foods: [validFood('remote-food', 'Remote food')],
      meals: [],
      recipes: [],
      measurements: [],
      settings: [],
    },
  }), { status: 200 }));
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    await assert.rejects(pullFromWebDav(), /safety backup could not be verified/i);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.deepEqual((await getAll('foods')).map(food => food.id), ['local-food']);
});
