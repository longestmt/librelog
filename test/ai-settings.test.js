import test from 'node:test';
import assert from 'node:assert/strict';
import { saveAISettingsSafely, withAISettingsLock } from '../src/integrations/ai-settings.js';
import { withDataLifecycleLock } from '../src/data/operation-locks.js';

function memoryWriters({ failOn } = {}) {
  const state = new Map([
    ['ai_provider', 'openai'],
    ['ai_api_key_provider', 'openai'],
    ['credential:aiApiKey', 'old-openai-key'],
  ]);
  const writes = [];
  const maybeFail = label => {
    writes.push(label);
    if (label === failOn) throw new Error('simulated write failure');
  };
  return {
    state,
    writes,
    dependencies: {
      async readSetting(key, fallback = null) {
        return state.has(key) ? state.get(key) : fallback;
      },
      async writeSetting(key, value) {
        maybeFail(`setting:${key}`);
        state.set(key, value);
      },
      async writeCredential(name, value) {
        maybeFail(`credential:${name}`);
        state.set(`credential:${name}`, value);
      },
      async readCredential(name) {
        return state.get(`credential:${name}`) || null;
      },
      async deleteCredential(name) {
        maybeFail(`delete:${name}`);
        state.delete(`credential:${name}`);
      },
    },
  };
}

function serialLockManager() {
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

test('provider activation happens only after its credential is safely rebound', async () => {
  const memory = memoryWriters();
  await saveAISettingsSafely({
    provider: 'anthropic',
    apiKey: 'new-anthropic-key',
    model: 'claude-test',
    ollamaUrl: 'http://localhost:11434',
  }, memory.dependencies);

  assert.deepEqual(memory.writes.slice(0, 3), [
    'setting:ai_api_key_provider',
    'credential:aiApiKey',
    'setting:ai_api_key_provider',
  ]);
  assert.equal(memory.writes.at(-1), 'setting:ai_provider');
  assert.equal(memory.state.get('ai_provider'), 'anthropic');
  assert.equal(memory.state.get('ai_api_key_provider'), 'anthropic');
});

test('a credential write failure leaves the old provider unable to use the new key', async () => {
  const memory = memoryWriters({ failOn: 'setting:ai_api_key_provider' });
  // Fail the second binding write, after the new key has been stored.
  let bindingWrites = 0;
  memory.dependencies.writeSetting = async (key, value) => {
    memory.writes.push(`setting:${key}`);
    if (key === 'ai_api_key_provider' && ++bindingWrites === 2) {
      throw new Error('simulated binding failure');
    }
    memory.state.set(key, value);
  };

  await assert.rejects(() => saveAISettingsSafely({
    provider: 'anthropic',
    apiKey: 'new-anthropic-key',
    model: 'claude-test',
    ollamaUrl: 'http://localhost:11434',
  }, memory.dependencies));

  assert.equal(memory.state.get('ai_provider'), 'openai');
  assert.equal(memory.state.get('credential:aiApiKey'), 'new-anthropic-key');
  assert.equal(memory.state.get('ai_api_key_provider'), null);
  assert.notEqual(memory.state.get('ai_api_key_provider'), memory.state.get('ai_provider'));
});

test('concurrent provider saves cannot cross-bind their credentials', async () => {
  const memory = memoryWriters();
  const locks = serialLockManager();
  const dependencies = { ...memory.dependencies, lockManager: locks };

  await Promise.all([
    saveAISettingsSafely({
      provider: 'anthropic',
      apiKey: 'anthropic-key',
      model: 'claude-test',
      ollamaUrl: 'http://localhost:11434',
    }, dependencies),
    saveAISettingsSafely({
      provider: 'openai',
      apiKey: 'openai-key',
      model: 'gpt-test',
      ollamaUrl: 'http://localhost:11434',
    }, dependencies),
  ]);

  assert.equal(memory.state.get('ai_provider'), 'openai');
  assert.equal(memory.state.get('ai_api_key_provider'), 'openai');
  assert.equal(memory.state.get('credential:aiApiKey'), 'openai-key');
});

test('a queued blank-key save revalidates provider binding inside the lock', async () => {
  const memory = memoryWriters();
  memory.state.set('ai_provider', 'anthropic');
  memory.state.set('ai_api_key_provider', 'anthropic');
  memory.state.set('credential:aiApiKey', 'anthropic-key');

  await assert.rejects(() => saveAISettingsSafely({
    provider: 'openai',
    apiKey: '',
    model: 'gpt-test',
    ollamaUrl: 'http://localhost:11434',
  }, memory.dependencies), error => error.code === 'AI_KEY_REQUIRED');

  assert.equal(memory.state.get('ai_provider'), 'anthropic');
  assert.equal(memory.state.get('ai_api_key_provider'), 'anthropic');
});

test('request-side configuration snapshots wait for provider writes', async () => {
  const memory = memoryWriters();
  const locks = serialLockManager();
  const dependencies = { ...memory.dependencies, lockManager: locks };
  const saving = saveAISettingsSafely({
    provider: 'anthropic',
    apiKey: 'anthropic-key',
    model: 'claude-test',
    ollamaUrl: 'http://localhost:11434',
  }, dependencies);
  const snapshot = withDataLifecycleLock(
    () => withAISettingsLock(() => ({
      provider: memory.state.get('ai_provider'),
      binding: memory.state.get('ai_api_key_provider'),
      key: memory.state.get('credential:aiApiKey'),
    }), locks),
    locks,
  );

  await saving;
  assert.deepEqual(await snapshot, {
    provider: 'anthropic',
    binding: 'anthropic',
    key: 'anthropic-key',
  });
});

test('Clear All queues behind an in-flight AI credential save and ends empty', async () => {
  const memory = memoryWriters();
  const locks = serialLockManager();
  let releaseCredential;
  let credentialWriteStarted;
  const started = new Promise(resolve => { credentialWriteStarted = resolve; });
  const release = new Promise(resolve => { releaseCredential = resolve; });
  const dependencies = {
    ...memory.dependencies,
    lockManager: locks,
    async writeCredential(name, value) {
      credentialWriteStarted();
      await release;
      memory.state.set(`credential:${name}`, value);
    },
  };

  const saving = saveAISettingsSafely({
    provider: 'anthropic',
    apiKey: 'new-anthropic-key',
    model: 'claude-test',
    ollamaUrl: 'http://localhost:11434',
  }, dependencies);
  await started;
  const clearing = withDataLifecycleLock(() => memory.state.clear(), locks);
  releaseCredential();

  await saving;
  await clearing;
  assert.equal(memory.state.size, 0);
});
