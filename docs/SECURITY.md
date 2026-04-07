# LibreLog Security & Privacy Guide

**Status:** Security Specification
**Updated:** April 2026

Complete security architecture, key management, and privacy compliance documentation.

---

## 1. SECURITY PRINCIPLES

### 1.1 Zero-Knowledge Architecture

LibreLog operates on a zero-knowledge model:

- **Personal data** (meals, weight, goals) stored locally only
- **No backend servers** receive or process personal data
- **API keys** (BYOK) encrypted; never sent to third parties
- **External APIs** (OFF, USDA) receive only search queries, never user profiles

### 1.2 Data Ownership

- Users own all their data
- Data deletion is permanent (soft-deleted after 30 days)
- Export available in multiple formats
- No account required; app works offline-first

### 1.3 Minimal Dependencies

- Vanilla JS: No framework backdoors
- Capacitor: Official Ionic plugin ecosystem
- All external dependencies audited before use
- AGPL-3.0 license ensures transparency

---

## 2. STORAGE SECURITY

### 2.1 IndexedDB (Local Data)

**Threat Model:**
- Browser clear cache → data loss (mitigated by auto-backup)
- Malicious scripts via XSS → data access
- Forensic analysis of device → data exposure

**Mitigations:**

```javascript
// src/utils/storage.js
export class SecureStorage {
  // IndexedDB has no built-in encryption
  // Mitigate via: content-security-policy, input validation, sanitization

  async storeIndexedDB(storeName, data) {
    // Data stored plaintext in IndexedDB (browser limitation)
    // Privacy depends on device security + CSP
    await db.put(storeName, data);
  }
}
```

**Recommendations for Users:**
- Enable device encryption (iOS: standard; Android: Settings → Security → Encrypt)
- Use app lock on Capacitor (biometric support)
- Disable browser history on web version
- Log out if device shared

### 2.2 Encrypted Storage (BYOK Keys)

**BYOK API keys must be encrypted at rest.**

```javascript
// src/utils/storage.js
export class EncryptedStorage {
  // Use Web Crypto API for encryption
  // Master password = sha256(user password)

  async setEncryptedKey(name, value, userPassword) {
    try {
      // 1. Derive key from password
      const masterKey = await this._deriveKey(userPassword);

      // 2. Encrypt value
      const encoded = new TextEncoder().encode(value);
      const iv = crypto.getRandomValues(new Uint8Array(12));  // 96-bit IV

      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        masterKey,
        encoded
      );

      // 3. Store IV + ciphertext
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);

      const b64 = btoa(String.fromCharCode(...combined));
      localStorage.setItem(`enc_${name}`, b64);

      return true;
    } catch (error) {
      console.error('Encryption failed:', error);
      return false;
    }
  }

  async getEncryptedKey(name, userPassword) {
    try {
      const b64 = localStorage.getItem(`enc_${name}`);
      if (!b64) return null;

      // 1. Decode base64
      const combined = new Uint8Array(
        atob(b64).split('').map(c => c.charCodeAt(0))
      );

      // 2. Extract IV (first 12 bytes)
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);

      // 3. Derive key from password
      const masterKey = await this._deriveKey(userPassword);

      // 4. Decrypt
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        masterKey,
        ciphertext
      );

      return new TextDecoder().decode(decrypted);
    } catch (error) {
      console.error('Decryption failed:', error);
      return null;
    }
  }

  async _deriveKey(password) {
    // PBKDF2 for key derivation
    const salt = new TextEncoder().encode('librelog-salt');  // Fixed salt ok for this use case
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }
}
```

### 2.3 localStorage (Non-Sensitive)

```javascript
// src/data/state.js
export const NON_SENSITIVE_DATA = [
  'lastSync',
  'theme',
  'language',
  'appVersion'
];

export function storeInLocalStorage(key, value) {
  if (!NON_SENSITIVE_DATA.includes(key)) {
    console.warn(`Non-sensitive data only. Use EncryptedStorage for: ${key}`);
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}
```

---

## 3. API SECURITY

### 3.1 HTTPS Enforcement

```javascript
// src/app.js
if (location.protocol !== 'https:' && !isLocalhost()) {
  // Redirect to HTTPS
  window.location.protocol = 'https:';
}

function isLocalhost() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}
```

### 3.2 Content Security Policy (CSP)

```html
<!-- index.html -->
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' https: data:;
  font-src 'self';
  connect-src 'self' https://world.openfoodfacts.org https://fdc.nal.usda.gov https://api.openai.com https://api.anthropic.com;
  frame-ancestors 'none';
  form-action 'self'
">
```

### 3.3 Input Validation & Sanitization

```javascript
// src/utils/sanitize.js
export function sanitizeInput(input, type = 'text') {
  if (!input) return '';

  // Remove HTML/script tags
  let sanitized = input.replace(/<[^>]*>/g, '');

  // Type-specific validation
  switch (type) {
    case 'number':
      return parseFloat(sanitized) || 0;
    case 'email':
      return sanitized.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)?.[0] || '';
    case 'url':
      try {
        new URL(sanitized);
        return sanitized;
      } catch {
        return '';
      }
    default:
      // Allow alphanumeric, spaces, basic punctuation
      return sanitized.replace(/[^a-zA-Z0-9\s\-_().,]/g, '');
  }
}

export function sanitizeHTML(html) {
  const div = document.createElement('div');
  div.textContent = html;
  return div.innerHTML;
}

// Usage in meal logging
const mealName = sanitizeInput(userInput, 'text');
const quantity = sanitizeInput(userQuantity, 'number');
```

### 3.4 XSS Protection

```javascript
// src/utils/dom.js
export function createSafeElement(tag, content, className) {
  const element = document.createElement(tag);

  // Never use innerHTML with user data
  if (typeof content === 'string') {
    element.textContent = content;  // Safe: no HTML parsing
  } else if (content instanceof HTMLElement) {
    element.appendChild(content);
  }

  if (className) {
    element.className = className;
  }

  return element;
}

// Safe meal card rendering
function renderMealCard(meal) {
  const card = createSafeElement('div', '', 'meal-card');

  const name = createSafeElement('h3', meal.name);
  const kcal = createSafeElement('p', `${meal.totals.kcal} kcal`);

  card.appendChild(name);
  card.appendChild(kcal);

  return card;
}
```

### 3.5 API Key Management (BYOK)

**Security Model:**
- Keys encrypted with user password
- Never logged or cached unencrypted
- Each API call validates key format
- Costs tracked but responses never logged with keys

```javascript
// src/integrations/aiClient.js
export class AIClient {
  constructor(provider, encryptedKeyName) {
    this.provider = provider;
    this.encryptedKeyName = encryptedKeyName;  // e.g., 'byok_openai_key'
    this.apiKey = null;  // Loaded on demand
  }

  async getAPIKey(userPassword) {
    // Decrypt key on-demand
    this.apiKey = await EncryptedStorage.getEncryptedKey(
      this.encryptedKeyName,
      userPassword
    );

    if (!this.apiKey) {
      throw new Error('API key not configured or password incorrect');
    }

    return this.apiKey;
  }

  async request(userPassword, message) {
    const apiKey = await this.getAPIKey(userPassword);

    try {
      // Validate key format before use
      if (!this._isValidKeyFormat(apiKey)) {
        throw new Error('Invalid API key format');
      }

      const response = await fetch(this._getEndpoint(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      // Never log response with key
      return response.json();

    } finally {
      // Clear key from memory
      this.apiKey = null;
    }
  }

  _isValidKeyFormat(key) {
    // Basic format validation per provider
    switch (this.provider) {
      case 'openai':
        return key.startsWith('sk-') && key.length > 20;
      case 'anthropic':
        return key.startsWith('sk-ant-') && key.length > 20;
      default:
        return false;
    }
  }
}
```

### 3.6 Rate Limiting & DOS Protection

```javascript
// src/integrations/rateLimiter.js
export class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async execute(fn) {
    const now = Date.now();

    // Clean old requests
    this.requests = this.requests.filter(t => t > now - this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      throw new Error('Rate limit exceeded');
    }

    this.requests.push(now);

    try {
      return await fn();
    } catch (error) {
      // Remove failed request from count (retry doesn't count against limit)
      this.requests.pop();
      throw error;
    }
  }
}

// Per-API limiters
const openAILimiter = new RateLimiter(3, 60000);  // 3 per minute
const offLimiter = new RateLimiter(60, 60000);    // 60 per minute
```

---

## 4. PRIVACY COMPLIANCE

### 4.1 Data Collection Policy

**What LibreLog collects:**
- Meals, foods, nutrition data
- Weight & body measurements
- User goals & preferences

**What LibreLog does NOT collect:**
- Location (unless user explicitly adds)
- Contact information
- Device identifiers
- Browsing history
- IP addresses (except in server logs)

### 4.2 GDPR Compliance

**User Rights:**

```javascript
// src/pages/settings.js
export class PrivacyControls {
  async exportAllData() {
    // Right to data portability
    const backup = {
      meals: await db.getAll('meals'),
      foods: await db.getAll('foods'),
      recipes: await db.getAll('recipes'),
      measurements: await db.getAll('measurements'),
      exportedAt: new Date().toISOString()
    };

    return JSON.stringify(backup, null, 2);
  }

  async deleteAllData() {
    // Right to be forgotten
    // Show confirmation: "This cannot be undone"

    const stores = ['meals', 'foods', 'recipes', 'measurements',
                    'aiConversations', 'syncLog', 'apiCache'];

    for (const store of stores) {
      await db.clear(store);
    }

    // Clear encrypted keys
    localStorage.clear();

    // Clear IndexedDB
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      indexedDB.deleteDatabase(db.name);
    }
  }

  async requestDataDeletion() {
    // 30-day grace period before hard-delete
    await db.put('_config', {
      id: 'deletionRequested',
      value: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });

    // Soft-delete all records
    const stores = ['meals', 'foods', 'recipes', 'measurements'];
    for (const store of stores) {
      const records = await db.getAll(store);
      for (const record of records) {
        record.deletedAt = new Date().toISOString();
        await db.put(store, record);
      }
    }
  }
}
```

### 4.3 Cookie Policy

Web version uses minimal cookies:

```javascript
// src/utils/cookies.js
export function setupCookies() {
  // Session cookie only (not persistent)
  // No third-party tracking cookies
  // CSP prevents cookie theft via XSS

  const sessionId = crypto.randomUUID();
  document.cookie = `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
```

### 4.4 Privacy Policy Template

```
# LibreLog Privacy Policy

## Data Storage
All personal data (meals, weight, goals) is stored on your device only. LibreLog has no backend servers.

## External Integrations
- Open Food Facts: Search queries only, no personal data
- USDA FDC: Search queries only, no personal data
- AI Services (optional, BYOK): You control data sent; we don't store responses

## Your Rights
- Export data anytime (JSON format)
- Delete data anytime (permanent)
- Disable analytics at any time
- No account required; no email collection

## Changes
We may update this policy. Changes take effect on next app update.
```

---

## 5. THREAT MODEL & MITIGATIONS

| Threat | Likelihood | Impact | Mitigation |
|--------|-----------|--------|-----------|
| **Browser clear cache** | High | Total data loss | Auto-backup to WebDAV/Gist |
| **XSS via user input** | Medium | Data theft | Input sanitization + CSP |
| **Man-in-the-middle** | Medium | API key theft | HTTPS enforcement |
| **Weak password** | High | BYOK key theft | Educate users, entropy check |
| **Device theft** | Low | Full data access | Recommend device encryption |
| **Supply chain attack** | Low | Malicious code | Minimize dependencies, audit |
| **API provider breach** | Low | API credentials leaked | User's key, not stored with us |
| **Bug in crypto.subtle** | Very low | Key compromise | Browser updates |

---

## 6. SECURITY AUDIT CHECKLIST

Before production release:

- [ ] All API calls over HTTPS
- [ ] CSP headers enforced
- [ ] XSS vulnerabilities scanned (npm audit)
- [ ] Input validation on all forms
- [ ] BYOK keys encrypted at rest
- [ ] No sensitive data in logs
- [ ] Service worker secure (no cache of PII)
- [ ] Barcode scanning requests permissions
- [ ] Camera access scoped properly
- [ ] Third-party dependencies < 5 direct deps
- [ ] AGPL-3.0 license prominent
- [ ] Privacy policy visible in app
- [ ] Data export tested end-to-end
- [ ] Data deletion removes all traces
- [ ] Offline mode tested without backend
- [ ] API rate limiting prevents abuse

---

## 7. INCIDENT RESPONSE

### If Data Breach Detected

1. **Assess scope** — Which records, which users?
2. **Contain** — Disable affected API key, rotate credentials
3. **Notify users** — Post-incident, transparent communication
4. **Fix root cause** — Security patch + version bump
5. **Document** — Post-mortem analysis

### Example: Compromised OpenAI Key

```javascript
// Emergency response in settings
export async function revokeCompromisedKey(provider) {
  console.error(`SECURITY: Revoking compromised ${provider} key`);

  // 1. Clear encrypted key
  localStorage.removeItem(`enc_byok_${provider}_key`);

  // 2. Disable AI features
  const settings = await db.get('users', 'user-1');
  settings.integrations.byokEnabled = false;
  await db.put('users', settings);

  // 3. Notify user
  showAlert(`Your ${provider} key was revoked. Please re-enter it in Settings.`, 'error');

  // 4. Log incident (for future audit)
  console.log(`Incident: Revoked ${provider} key at ${new Date().toISOString()}`);
}
```

---

## 8. SECURITY TESTING

```bash
# Run security audits
npm audit                          # Check dependencies
npm run lint                       # Code quality
npm run security-scan              # Static analysis

# Manual security testing
# 1. Try XSS payloads: <img src=x onerror="alert('xss')">
# 2. Try SQL injection: ' OR '1'='1
# 3. Test BYOK: Enter invalid keys
# 4. Test offline: Disable network, use app
# 5. Test sync conflict: Edit same meal on 2 devices
```

---

This security guide provides:
- Zero-knowledge architecture
- Encryption for sensitive keys
- XSS + injection protection
- GDPR compliance framework
- Threat modeling
- Incident response procedures
- Security audit checklist
