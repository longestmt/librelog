import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, setSetting } from '../src/data/db.js';
import { chatCompletion, isAIConfigured } from '../src/integrations/aiClient.js';
import {
  convertMessagesForOllama,
  normalizeOllamaUrl,
} from '../src/integrations/ollama.js';

test('Ollama URLs are limited to literal loopback hosts', () => {
  assert.equal(normalizeOllamaUrl(' http://localhost:11434/ '), 'http://localhost:11434');
  assert.equal(normalizeOllamaUrl('https://127.0.0.1:11434/ollama/'), 'https://127.0.0.1:11434/ollama');
  assert.equal(normalizeOllamaUrl('http://[::1]:11434'), 'http://[::1]:11434');

  assert.throws(() => normalizeOllamaUrl('https://ollama.example.com'), /localhost/i);
  assert.throws(() => normalizeOllamaUrl('http://user:pass@localhost:11434'), /credentials/i);
  assert.throws(() => normalizeOllamaUrl('file:///tmp/ollama.sock'), /HTTP/i);
  assert.throws(() => normalizeOllamaUrl('http://localhost:11434?next=remote'), /query/i);
});

test('Ollama multimodal conversion separates text and base64 images', () => {
  assert.deepEqual(convertMessagesForOllama([
    { role: 'system', content: 'Identify the meal.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Two eggs and toast' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJjZA==' } },
      ],
    },
  ]), [
    { role: 'system', content: 'Identify the meal.' },
    { role: 'user', content: 'Two eggs and toast', images: ['YWJjZA=='] },
  ]);

  assert.throws(
    () => convertMessagesForOllama([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/meal.jpg' } }],
    }]),
    /local base64 data URLs/i,
  );
});

test('Ollama chat sends the native multimodal payload to a loopback endpoint', async t => {
  await clearAllData();
  await setSetting('ai_provider', 'ollama');
  await setSetting('ai_model', 'llava:test');
  await setSetting('ai_ollama_url', 'http://localhost:11434/');

  let requestUrl = null;
  let requestBody = null;
  let requestRedirect = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requestUrl = String(url);
    requestBody = JSON.parse(init.body);
    requestRedirect = init.redirect;
    return Response.json({ message: { content: '{}' } });
  });

  const result = await chatCompletion([{
    role: 'user',
    content: [
      { type: 'text', text: 'Estimate this meal' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz' } },
    ],
  }], { jsonMode: true });

  assert.equal(result.content, '{}');
  assert.equal(requestUrl, 'http://localhost:11434/api/chat');
  assert.equal(requestRedirect, 'error');
  assert.deepEqual(requestBody.messages, [{
    role: 'user',
    content: 'Estimate this meal',
    images: ['cGl4ZWxz'],
  }]);
  assert.equal(requestBody.format, 'json');
});

test('imported remote Ollama settings cannot trigger a request', async t => {
  await clearAllData();
  await setSetting('ai_provider', 'ollama');
  await setSetting('ai_model', 'test-model');
  await setSetting('ai_ollama_url', 'https://ollama.example.com');
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return Response.json({ message: { content: '{}' } });
  });

  assert.equal(await isAIConfigured(), false);
  const result = await chatCompletion([{ role: 'user', content: 'Do not send this' }]);
  assert.match(result.error, /loopback URL/i);
  assert.equal(fetchCount, 0);
});
