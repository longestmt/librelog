const FORMAT = 'librelog-encrypted-backup';
const FORMAT_VERSION = 1;
const ITERATIONS = 600_000;
const KEY_LENGTH = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ADDITIONAL_DATA = new TextEncoder().encode(`${FORMAT}:${FORMAT_VERSION}`);

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value, expectedLength = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Encrypted backup contains invalid binary data');
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error('Encrypted backup contains invalid binary data');
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (expectedLength !== null && bytes.length !== expectedLength) {
    throw new Error('Encrypted backup contains invalid binary data');
  }
  return bytes;
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('Passphrase must contain at least 8 characters');
  }
}

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations,
  }, material, {
    name: 'AES-GCM',
    length: KEY_LENGTH,
  }, false, ['encrypt', 'decrypt']);
}

export function isEncryptedBackup(value) {
  return value?.format === FORMAT && value?.version === FORMAT_VERSION;
}

export async function encryptBackup(data, passphrase) {
  validatePassphrase(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: ADDITIONAL_DATA,
  }, key, plaintext);

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    algorithm: 'AES-GCM',
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: ITERATIONS,
      salt: bytesToBase64(salt),
    },
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptBackup(payload, passphrase) {
  validatePassphrase(passphrase);
  const iterations = payload?.kdf?.iterations;
  if (!isEncryptedBackup(payload)
    || payload.algorithm !== 'AES-GCM'
    || payload.kdf?.name !== 'PBKDF2'
    || payload.kdf?.hash !== 'SHA-256'
    || !Number.isInteger(iterations)
    || iterations < 100_000
    || iterations > 5_000_000) {
    throw new Error('Encrypted backup format is not supported');
  }

  const salt = base64ToBytes(payload.kdf.salt, SALT_BYTES);
  const iv = base64ToBytes(payload.iv, IV_BYTES);
  const ciphertext = base64ToBytes(payload.ciphertext);
  if (ciphertext.length < 17 || ciphertext.length > 50 * 1024 * 1024) {
    throw new Error('Encrypted backup size is invalid');
  }

  try {
    const key = await deriveKey(passphrase, salt, iterations);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: ADDITIONAL_DATA,
    }, key, ciphertext);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    return JSON.parse(text);
  } catch {
    throw new Error('Passphrase is incorrect or the backup is damaged');
  }
}
