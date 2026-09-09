import { hasRemoteProviderConsent } from './privacy.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class IntegrationError extends Error {
  constructor(message, {
    provider,
    code,
    status = null,
    retryable = false,
  }) {
    super(message);
    this.name = 'IntegrationError';
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function safeError(provider, code, status = null) {
  if (code === 'cancelled') {
    return new IntegrationError(`${provider} request was cancelled.`, {
      provider, code, status, retryable: false,
    });
  }
  if (code === 'timeout') {
    return new IntegrationError(`${provider} request timed out.`, {
      provider, code, status, retryable: true,
    });
  }
  if (code === 'http') {
    const suffix = status === 401 || status === 403
      ? ' Check the integration settings.'
      : '';
    return new IntegrationError(`${provider} request failed (${status}).${suffix}`, {
      provider,
      code,
      status,
      retryable: RETRYABLE_STATUS.has(status),
    });
  }
  if (code === 'invalid-response') {
    return new IntegrationError(`${provider} returned an invalid response.`, {
      provider, code, status, retryable: false,
    });
  }
  if (code === 'consent-required') {
    return new IntegrationError(`${provider} is off until you enable it.`, {
      provider, code, status, retryable: false,
    });
  }
  return new IntegrationError(`${provider} is not available.`, {
    provider, code: 'network', status, retryable: true,
  });
}

function waitForRetry(delayMs, signal, provider) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(safeError(provider, 'cancelled'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(safeError(provider, 'cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestOnce({ provider, url, init, signal, timeoutMs, responseType }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    if (signal?.aborted) throw safeError(provider, 'cancelled');
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw safeError(provider, 'http', response.status);

    try {
      const data = responseType === 'text'
        ? await response.text()
        : await response.json();
      return { data, status: response.status, headers: response.headers };
    } catch {
      throw safeError(provider, 'invalid-response', response.status);
    }
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    if (signal?.aborted) throw safeError(provider, 'cancelled');
    if (timedOut || error?.name === 'AbortError') throw safeError(provider, 'timeout');
    throw safeError(provider, 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Get JSON from one remote integration.
 * The function never puts response text, request data, or a URL in an error.
 */
async function requestRemote({
  provider,
  url,
  init = {},
  signal = null,
  consentKey = null,
  responseType = 'json',
  timeoutMs = 10_000,
  maxRetries = 0,
  retryDelayMs = 250,
}) {
  if (!provider || !url) throw new Error('Integration request requires a provider and URL');
  if (consentKey && !(await hasRemoteProviderConsent(consentKey))) {
    throw safeError(provider, 'consent-required');
  }
  const retryLimit = Math.max(0, Math.min(2, Number(maxRetries) || 0));

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      return await requestOnce({ provider, url, init, signal, timeoutMs, responseType });
    } catch (error) {
      if (!(error instanceof IntegrationError)
        || !error.retryable
        || attempt === retryLimit
        || signal?.aborted) {
        throw error;
      }
      await waitForRetry(retryDelayMs * (attempt + 1), signal, provider);
    }
  }
  throw safeError(provider, 'network');
}

/** Make a consent-gated request whose successful body is JSON. */
export function requestJSON(options) {
  return requestRemote({ ...options, responseType: 'json' });
}

/** Make a consent-gated request whose successful body is plain text. */
export function requestText(options) {
  return requestRemote({ ...options, responseType: 'text' });
}

export function getSafeIntegrationMessage(error, fallback = 'The integration request failed.') {
  return error instanceof IntegrationError ? error.message : fallback;
}

export function logIntegrationFailure(error) {
  if (!(error instanceof IntegrationError)) {
    console.warn('[integration] request failed', { code: 'internal' });
    return;
  }
  console.warn('[integration] request failed', {
    provider: error.provider,
    code: error.code,
    status: error.status,
    retryable: error.retryable,
  });
}
