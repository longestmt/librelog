import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  BACKUP_SCHEMA_VERSION,
  clearAllData,
  getAll,
  getSetting,
  put,
  setSetting,
} from '../src/data/db.js';
import {
  clearAllDataAndBackups,
  listenForExternalDataClear,
  performBackup,
  replaceAllDataWithSafetyBackup,
} from '../src/data/auto-backup.js';
import { setCredential } from '../src/data/credentials.js';
import {
  assertDataMutationGenerationCurrent,
  captureDataMutationGeneration,
  DATA_MUTATION_GENERATION_STORAGE_KEY,
  withDataDestructiveLock,
  withDataWriteLock,
} from '../src/data/operation-locks.js';
import {
  ADD_DRAFT_STORAGE_KEY,
  createAddDraft,
  saveAddDraft,
  saveAddDraftIfCurrent,
} from '../src/data/add-draft.js';
import { createMeal } from '../src/data/meal-commands.js';
import { updateMeasurement } from '../src/data/measurement-commands.js';
import { searchFoods } from '../src/engine/food-search.js';
import { grantRemoteProviderConsent } from '../src/integrations/privacy.js';
import {
  activateStoredWebDavConfig,
  getWebDavConfig,
  pullFromWebDav,
  setWebDavConfig,
  withWebDavConfigLock,
} from '../src/data/webdav.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function namedSerialLockManager() {
  const tails = new Map();
  return {
    request(name, _options, operation) {
      const prior = tails.get(name) || Promise.resolve();
      const result = prior.then(() => operation());
      tails.set(name, result.catch(() => {}));
      return result;
    },
  };
}

function webLockManager() {
  const states = new Map();
  const getState = name => {
    if (!states.has(name)) states.set(name, { exclusive: false, shared: 0, queue: [] });
    return states.get(name);
  };
  const available = (state, mode) => !state.exclusive && (mode === 'shared' || state.shared === 0);
  const release = (name, mode) => {
    const state = getState(name);
    if (mode === 'shared') state.shared -= 1;
    else state.exclusive = false;
    drain(name);
  };
  const grant = (name, request) => {
    const state = getState(name);
    if (request.mode === 'shared') state.shared += 1;
    else state.exclusive = true;
    Promise.resolve()
      .then(() => request.operation({ name, mode: request.mode }))
      .then(value => {
        release(name, request.mode);
        request.resolve(value);
      }, error => {
        release(name, request.mode);
        request.reject(error);
      });
  };
  const drain = name => {
    const state = getState(name);
    if (!state.queue.length || !available(state, state.queue[0].mode)) return;
    if (state.queue[0].mode === 'exclusive') {
      grant(name, state.queue.shift());
      return;
    }
    while (state.queue[0]?.mode === 'shared' && available(state, 'shared')) {
      grant(name, state.queue.shift());
    }
  };
  return {
    request(name, options, operation) {
      const mode = options?.mode || 'exclusive';
      const state = getState(name);
      if (options?.ifAvailable && !available(state, mode)) {
        return Promise.resolve().then(() => operation(null));
      }
      return new Promise((resolve, reject) => {
        state.queue.push({ mode, operation, resolve, reject });
        drain(name);
      });
    },
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function validFood(id, name) {
  return {
    id,
    name,
    servingSize: { quantity: 100, unit: 'g', aliases: [] },
    nutrients: {
      energy: { kcal: 100 },
      macros: {
        protein: { g: 1 },
        carbs: { g: 2 },
        fat: { g: 3 },
      },
      fiber: { g: null },
      sodium: { mg: null },
    },
  };
}

test('Clear All waits for an in-flight backup, then removes its snapshot', async () => {
  await clearAllData();
  await put('foods', validFood('before-clear', 'Before clear'));
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const locks = namedSerialLockManager();
  const writeStarted = deferred();
  const releaseWrite = deferred();
  const pauseAfterExport = async () => {
    writeStarted.resolve();
    await releaseWrite.promise;
    return false;
  };

  const backup = performBackup({
    lockManager: locks,
    saveFilesystem: pauseAfterExport,
  });
  await writeStarted.promise;
  const clearing = clearAllDataAndBackups({ lockManager: locks });

  releaseWrite.resolve();
  assert.equal(await backup, true);
  await clearing;

  assert.equal(storage.getItem('librelog_backups'), null);
  assert.deepEqual(await getAll('foods'), []);
});

test('Clear All waits for an in-flight ordinary writer and erases its result', async () => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  const locks = namedSerialLockManager();
  const writeStarted = deferred();
  const releaseWrite = deferred();

  const writing = withDataWriteLock(async writeLockToken => {
    writeStarted.resolve();
    await releaseWrite.promise;
    await put('foods', validFood('late-write', 'Late write'), {
      writeLockToken,
      lockManager: locks,
    });
  }, locks);
  await writeStarted.promise;
  const clearing = clearAllDataAndBackups({ lockManager: locks });

  releaseWrite.resolve();
  await writing;
  await clearing;

  assert.deepEqual(await getAll('foods'), []);
});

test('the local lock fallback makes destructive work wait for an existing writer', async () => {
  globalThis.localStorage = memoryStorage();
  const writeStarted = deferred();
  const releaseWrite = deferred();
  let destructionStarted = false;

  const writing = withDataWriteLock(async () => {
    writeStarted.resolve();
    await releaseWrite.promise;
  }, null);
  await writeStarted.promise;

  const destroying = withDataDestructiveLock(async () => {
    destructionStarted = true;
  }, null);
  assert.equal(destructionStarted, false);

  releaseWrite.resolve();
  await writing;
  await destroying;
  assert.equal(destructionStarted, true);
});

test('a failed persisted generation write still invalidates stale work locally', async () => {
  const storage = memoryStorage();
  storage.values.set(DATA_MUTATION_GENERATION_STORAGE_KEY, '5');
  storage.setItem = () => {
    throw new Error('Storage is read-only');
  };
  globalThis.localStorage = storage;
  const staleGeneration = captureDataMutationGeneration();

  await withDataDestructiveLock(async () => {}, null);

  assert.throws(
    () => assertDataMutationGenerationCurrent(staleGeneration),
    error => error.code === 'DATA_OPERATION_INVALIDATED',
  );
});

test('writes first attempted during Clear All are rejected instead of recreating data or drafts', async () => {
  await clearAllData();
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const locks = webLockManager();
  const draft = saveAddDraft(createAddDraft({ date: '2026-09-09' }), storage);
  const clearStarted = deferred();
  const finishClear = deferred();
  const clearing = clearAllDataAndBackups({
    lockManager: locks,
    removeBrowserCaches: async () => {
      clearStarted.resolve();
      await finishClear.promise;
    },
  });
  await clearStarted.promise;

  const isDestructiveConflict = error => (
    error.code === 'DATA_DESTRUCTIVE_OPERATION_IN_PROGRESS'
  );
  await assert.rejects(
    put('foods', validFood('during-clear', 'During clear'), { lockManager: locks }),
    isDestructiveConflict,
  );
  await assert.rejects(
    createMeal({
      date: '2026-09-09',
      type: 'lunch',
      items: [{ foodId: 'during-clear', quantity: 1, unit: 'serving' }],
    }, { idempotencyKey: 'test:during-clear-meal', lockManager: locks }),
    isDestructiveConflict,
  );
  await assert.rejects(
    updateMeasurement('during-clear', {
      date: '2026-09-09',
      weight: 70,
      unit: 'kg',
      bodyFat: null,
    }, {
      baseRecord: {
        id: 'during-clear',
        date: '2026-09-08',
        weight: 71,
        unit: 'kg',
        bodyFat: null,
      },
      lockManager: locks,
    }),
    isDestructiveConflict,
  );
  await assert.rejects(
    saveAddDraftIfCurrent(draft, { ...draft, items: [] }, {
      storage,
      lockManager: locks,
    }),
    isDestructiveConflict,
  );

  finishClear.resolve();
  await clearing;
  assert.deepEqual(await getAll('foods'), []);
  assert.deepEqual(await getAll('meals'), []);
  assert.equal(storage.getItem(ADD_DRAFT_STORAGE_KEY), null);
});

test('an unpersisted draft from before Clear All cannot become current afterward', async () => {
  await clearAllData();
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const staleDraft = createAddDraft({ date: '2026-09-09' });
  const mutationGeneration = captureDataMutationGeneration();

  await clearAllDataAndBackups();

  await assert.rejects(
    saveAddDraftIfCurrent(staleDraft, {
      ...staleDraft,
      items: [{ private: 'pre-reset item' }],
    }, { storage, mutationGeneration }),
    error => error.code === 'DATA_OPERATION_INVALIDATED',
  );
  assert.equal(storage.getItem(ADD_DRAFT_STORAGE_KEY), null);
});

test('privacy consent reviewed before Clear All cannot be granted afterward', async () => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  const mutationGeneration = captureDataMutationGeneration();

  await clearAllDataAndBackups();

  await assert.rejects(
    grantRemoteProviderConsent('openfoodfacts', { mutationGeneration }),
    error => error.code === 'DATA_OPERATION_INVALIDATED',
  );
  assert.equal(await getSetting('privacyConsent_openfoodfacts', false), false);
});

test('a remote search started before Clear All cannot recreate its private API cache afterward', async t => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  await setSetting('privacyConsent_openfoodfacts', true);
  const fetchStarted = deferred();
  const finishFetch = deferred();
  t.mock.method(globalThis, 'fetch', async () => {
    fetchStarted.resolve();
    await finishFetch.promise;
    return new Response(JSON.stringify({
      products: [{
        id: 'remote-product',
        code: '1234567890123',
        product_name: 'Private result',
        nutriments: { 'energy-kcal_100g': 100 },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const searching = searchFoods('private health query', {
    sources: { local: false, usda: false, off: true },
  });
  await fetchStarted.promise;
  await clearAllDataAndBackups();
  finishFetch.resolve();
  await searching;

  assert.deepEqual(await getAll('apiCache'), []);
});

test('Clear All aborts without erasing the database when native backup deletion fails', async () => {
  await clearAllData();
  const storage = memoryStorage();
  storage.setItem('librelog_backups', '[{"private":true}]');
  globalThis.localStorage = storage;
  await put('foods', validFood('must-remain', 'Must remain'));

  await assert.rejects(
    clearAllDataAndBackups({
      removeFilesystemBackups: async () => {
        const error = new Error('Permission denied');
        error.code = 'EACCES';
        throw error;
      },
    }),
    /permission denied/i,
  );

  assert.deepEqual((await getAll('foods')).map(food => food.id), ['must-remain']);
  assert.equal(storage.getItem('librelog_backups'), '[{"private":true}]');
});

test('Clear All aborts without erasing the database when private browser cache deletion fails', async () => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  await put('foods', validFood('cache-protected', 'Cache protected'));

  await assert.rejects(
    clearAllDataAndBackups({
      removeBrowserCaches: async () => {
        throw new Error('Cache storage permission denied');
      },
    }),
    /cache storage permission denied/i,
  );

  assert.deepEqual((await getAll('foods')).map(food => food.id), ['cache-protected']);
});

test('Clear All recreates a backup when IndexedDB rejects the erase', async t => {
  await clearAllData();
  const storage = memoryStorage();
  storage.setItem('librelog_backups', '[{"stale":true}]');
  globalThis.localStorage = storage;
  await put('foods', validFood('erase-failed', 'Erase failed'));
  await setSetting('lastBackupTime', Date.now());
  const prototype = globalThis.IDBObjectStore.prototype;
  const originalClear = prototype.clear;
  t.mock.method(prototype, 'clear', function abortClearAfterRequestSuccess(...args) {
    const request = originalClear.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  });

  await assert.rejects(clearAllDataAndBackups(), /aborted|failed/i);

  assert.deepEqual((await getAll('foods')).map(food => food.id), ['erase-failed']);
  const backups = JSON.parse(storage.getItem('librelog_backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(backups[0].data.stores.foods.map(food => food.id), ['erase-failed']);
});

test('a failed peer notification cannot make a completed Clear All appear to fail', async t => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  await put('foods', validFood('notification-test', 'Notification test'));
  t.mock.method(globalThis, 'BroadcastChannel', function BrokenBroadcastChannel() {
    throw new Error('BroadcastChannel is blocked');
  });

  const stopListening = listenForExternalDataClear(() => {});
  stopListening();
  await clearAllDataAndBackups();

  assert.deepEqual(await getAll('foods'), []);
});

test('a delayed WebDAV pull finishes before a queued Clear All erases it', async t => {
  await clearAllData();
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const locks = namedSerialLockManager();
  const fetchStarted = deferred();
  const releaseFetch = deferred();

  await setSetting('privacyConsent_webdav', true);
  await setSetting('webdav_connected', true);
  await setSetting('webdavUrl', 'https://example.invalid/dav/');
  await setSetting('webdavUsername', 'user');
  await setCredential('webdavPassword', 'password');
  await put('foods', validFood('local-before-pull', 'Local before pull'));

  const remoteBackup = {
    version: BACKUP_SCHEMA_VERSION,
    stores: {
      foods: [validFood('remote-food', 'Remote food')],
      meals: [],
      recipes: [],
      measurements: [],
      settings: [],
    },
  };
  t.mock.method(globalThis, 'fetch', async () => {
    fetchStarted.resolve();
    await releaseFetch.promise;
    return new Response(JSON.stringify(remoteBackup), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const pulling = pullFromWebDav({ lockManager: locks });
  await fetchStarted.promise;
  const clearing = clearAllDataAndBackups({ lockManager: locks });
  releaseFetch.resolve();

  assert.equal(await pulling, true);
  await clearing;
  assert.deepEqual(await getAll('foods'), []);
  assert.equal(storage.getItem('librelog_backups'), null);
});

test('WebDAV consent, validation, and config commit finish before queued Clear All', async t => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  const locks = namedSerialLockManager();
  const fetchStarted = deferred();
  const releaseFetch = deferred();
  t.mock.method(globalThis, 'fetch', async () => {
    fetchStarted.resolve();
    await releaseFetch.promise;
    return new Response('', { status: 207 });
  });

  const connecting = setWebDavConfig(
    'https://example.invalid/dav/',
    'user',
    'password',
    { confirmRemoteDataUse: true, lockManager: locks },
  );
  await fetchStarted.promise;
  const clearing = clearAllDataAndBackups({ lockManager: locks });
  releaseFetch.resolve();

  await connecting;
  await clearing;
  assert.equal(await getWebDavConfig({ lockManager: locks }).then(config => config.url), null);
});

test('legacy WebDAV activation cannot restore credentials after a queued Clear All', async t => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  const locks = webLockManager();
  await setSetting('webdav_url', 'https://legacy.example/dav/');
  await setSetting('webdav_username', 'legacy-user');
  await setCredential('webdavPassword', 'legacy-password');
  const configLockHeld = deferred();
  const releaseConfigLock = deferred();
  const blocker = withWebDavConfigLock(async () => {
    configLockHeld.resolve();
    await releaseConfigLock.promise;
  }, locks);
  await configLockHeld.promise;
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 207 }));

  const activating = activateStoredWebDavConfig({
    confirmRemoteDataUse: true,
    lockManager: locks,
  });
  const clearing = clearAllDataAndBackups({ lockManager: locks });
  releaseConfigLock.resolve();

  await blocker;
  await activating;
  await clearing;
  assert.deepEqual(await getWebDavConfig({ lockManager: locks }), {
    url: null,
    username: null,
    password: null,
    active: false,
  });
});

test('replacement aborts safely when ordinary data changes after its snapshot', async () => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  const locks = namedSerialLockManager();
  const snapshotSaved = deferred();
  const continueReplacement = deferred();
  await put('foods', validFood('current-food', 'Current food'));
  const replacement = {
    version: BACKUP_SCHEMA_VERSION,
    stores: {
      foods: [validFood('replacement-food', 'Replacement food')],
      meals: [],
      recipes: [],
      measurements: [],
      settings: [],
    },
  };

  const replacing = replaceAllDataWithSafetyBackup(replacement, {
    lockManager: locks,
    saveFilesystem: async () => {
      snapshotSaved.resolve();
      await continueReplacement.promise;
      return true;
    },
  });
  await snapshotSaved.promise;
  await put('measurements', {
    id: 'new-weight',
    date: '2026-09-09',
    weight: 70,
    unit: 'kg',
  });
  continueReplacement.resolve();

  await assert.rejects(replacing, error => error.code === 'DATA_CHANGED_DURING_REPLACE');
  assert.deepEqual((await getAll('foods')).map(food => food.id), ['current-food']);
  assert.deepEqual((await getAll('measurements')).map(entry => entry.id), ['new-weight']);
});

test('a restore decision from before another replacement cannot overwrite newer data', async () => {
  await clearAllData();
  globalThis.localStorage = memoryStorage();
  await put('foods', validFood('newer-food', 'Newer food'));
  const staleGeneration = captureDataMutationGeneration();
  await withDataDestructiveLock(async () => {}, null);
  const staleReplacement = {
    version: BACKUP_SCHEMA_VERSION,
    stores: {
      foods: [validFood('stale-food', 'Stale food')],
      meals: [],
      recipes: [],
      measurements: [],
      settings: [],
    },
  };

  await assert.rejects(
    replaceAllDataWithSafetyBackup(staleReplacement, {
      mutationGeneration: staleGeneration,
      saveFilesystem: async () => true,
    }),
    error => error.code === 'DATA_OPERATION_INVALIDATED',
  );
  assert.deepEqual((await getAll('foods')).map(food => food.id), ['newer-food']);
});
