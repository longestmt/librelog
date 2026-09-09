const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate and normalize the base URL used for the local Ollama integration.
 * Literal loopback hosts avoid DNS rebinding and accidental disclosure to a
 * remote server configured through Settings or a restored backup.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeOllamaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Ollama URL is required');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Ollama URL must be a valid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Ollama URL must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Ollama URL must not contain credentials');
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new Error('Ollama URL must use localhost, 127.0.0.1, or [::1]');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Ollama URL must not contain a query or fragment');
  }

  const pathname = parsed.pathname === '/'
    ? ''
    : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

function extractOllamaImage(part) {
  const imageUrl = typeof part?.image_url === 'string'
    ? part.image_url
    : part?.image_url?.url;
  if (!imageUrl) return null;

  const match = imageUrl.match(/^data:image\/[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error('Ollama images must use local base64 data URLs');
  }
  return match[1].replace(/\s/g, '');
}

/**
 * Convert OpenAI-compatible multimodal messages into Ollama's native chat
 * shape. Ollama expects text in `content` and raw base64 payloads in `images`.
 *
 * @param {Array<{role: string, content: string|Array}>} messages
 * @returns {Array<{role: string, content: string, images?: string[]}>}
 */
export function convertMessagesForOllama(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('Ollama messages must be an array');
  }

  return messages.map((message) => {
    if (!message || typeof message.role !== 'string') {
      throw new Error('Ollama message requires a role');
    }
    if (!Array.isArray(message.content)) {
      return {
        role: message.role,
        content: typeof message.content === 'string' ? message.content : '',
      };
    }

    const textParts = [];
    const images = [];
    for (const part of message.content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text);
      } else if (part?.type === 'image_url') {
        const image = extractOllamaImage(part);
        if (image) images.push(image);
      }
    }

    return {
      role: message.role,
      content: textParts.join('\n'),
      ...(images.length > 0 ? { images } : {}),
    };
  });
}
