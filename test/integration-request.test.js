import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IntegrationError,
  requestJSON,
} from '../src/integrations/request.js';

test('integration errors do not include a response body or request URL', async (t) => {
  const secretBody = 'private meal description: eggs and toast';
  t.mock.method(globalThis, 'fetch', async () => new Response(secretBody, { status: 500 }));

  await assert.rejects(
    requestJSON({
      provider: 'Test Provider',
      url: 'https://example.invalid/path?api_key=secret',
    }),
    error => {
      assert.equal(error instanceof IntegrationError, true);
      assert.equal(error.code, 'http');
      assert.equal(error.status, 500);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes(secretBody), false);
      assert.equal(error.message.includes('api_key'), false);
      return true;
    },
  );
});

test('integration timeouts and user cancellation have different codes', async (t) => {
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('Stopped', 'AbortError'));
    }, { once: true });
  }));

  await assert.rejects(
    requestJSON({
      provider: 'Slow Provider',
      url: 'https://example.invalid',
      timeoutMs: 5,
    }),
    error => error.code === 'timeout' && error.retryable === true,
  );

  const controller = new AbortController();
  const pending = requestJSON({
    provider: 'Slow Provider',
    url: 'https://example.invalid',
    signal: controller.signal,
    timeoutMs: 100,
  });
  controller.abort();
  await assert.rejects(
    pending,
    error => error.code === 'cancelled' && error.retryable === false,
  );
});

test('read-only integration requests use a bounded retry', async (t) => {
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    if (requestCount === 1) return new Response('', { status: 503 });
    return Response.json({ ok: true });
  });

  const result = await requestJSON({
    provider: 'Retry Provider',
    url: 'https://example.invalid',
    maxRetries: 1,
    retryDelayMs: 1,
  });

  assert.equal(result.data.ok, true);
  assert.equal(requestCount, 2);
});
