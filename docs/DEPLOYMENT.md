# LibreLog Deployment & Release Guide

**Status:** Deployment Specification
**Updated:** April 2026

Step-by-step instructions for building, testing, and releasing to web + native platforms.

---

## 1. DEVELOPMENT SETUP

### 1.1 Environment

```bash
Node.js: 18.x LTS or later
npm: 9.x or later
Xcode: 14.x (for iOS)
Android Studio: 2022.x (for Android)
```

### 1.2 Installation

```bash
# Clone repository
git clone https://github.com/libre-suite/librelog.git
cd librelog

# Install dependencies
npm install

# Install Capacitor
npm install @capacitor/cli @capacitor/core
npx cap init librelog com.libre.librelog

# Add native platforms
npx cap add ios
npx cap add android

# Install native plugins
npm install @capacitor/camera @capacitor/geolocation
npm install @capacitor-mlkit/barcode-scanning
npm install @capacitor-firebase/analytics
```

### 1.3 Development Server

```bash
# Start Vite dev server (http://localhost:5173)
npm run dev

# Watch for file changes, auto-reload
npm run dev -- --host  # Accessible on network

# Open in browser
open http://localhost:5173
```

---

## 2. BUILD PROCESS

### 2.1 Web Build

```bash
# Production build
npm run build

# Output: dist/
# - index.html
# - assets/main-{hash}.js
# - assets/style-{hash}.css
# - manifest.webmanifest
# - service-worker.js

# Preview locally
npm run preview  # http://localhost:4173
```

### 2.2 Build Optimization

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    target: 'es2020',
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: true }  // Remove console in prod
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor': ['vendor dependencies'],
          'api': ['src/integrations/'],
          'db': ['src/data/']
        }
      }
    }
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      strategies: 'injectManifest',
      manifest: {
        name: 'LibreLog',
        short_name: 'LibreLog',
        description: 'Open meal tracker and calorie counter',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#2E7D32',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff,woff2,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/world\.openfoodfacts\.org/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'off-api',
              expiration: { maxAgeSeconds: 7 * 24 * 60 * 60 }
            }
          },
          {
            urlPattern: /^https:\/\/fdc\.nal\.usda\.gov/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'usda-api',
              expiration: { maxAgeSeconds: 30 * 24 * 60 * 60 }
            }
          }
        ]
      }
    })
  ]
});
```

### 2.3 Bundle Size Analysis

```bash
# Check bundle size
npm install -D rollup-plugin-visualizer

# Add to vite.config.js
import { visualizer } from 'rollup-plugin-visualizer';

plugins: [
  visualizer({ open: true })
]

npm run build
# Opens visualization in browser
```

**Target:** <100KB total JS (gzip)

---

## 3. TESTING BEFORE RELEASE

### 3.1 Unit Tests

```bash
npm install -D vitest @vitest/ui

# Run tests
npm run test

# Watch mode
npm run test -- --watch

# Coverage report
npm run test -- --coverage
```

**Test files:**
```
src/data/__tests__/db.test.js
src/engine/__tests__/nutrition.test.js
src/integrations/__tests__/openFoodFacts.test.js
src/utils/__tests__/sanitize.test.js
```

### 3.2 Integration Tests

```bash
npm install -D playwright

# Test offline functionality
# Test sync workflow
# Test export/import
```

### 3.3 Manual Testing Checklist

- [ ] **Web**: Chrome, Firefox, Safari (latest)
- [ ] **Mobile**: iOS 14+, Android 8+
- [ ] **Offline**: Disable network, verify app works
- [ ] **Meals**: Create, edit, delete, export
- [ ] **Search**: Barcode, text, API fallback
- [ ] **Sync**: WebDAV upload/download
- [ ] **AI** (if enabled): Photo, voice, suggestions
- [ ] **Weight**: Track, view trends
- [ ] **Settings**: All toggles functional
- [ ] **Accessibility**: Keyboard nav, screen reader
- [ ] **Performance**: <2s page load, smooth scroll

### 3.4 Performance Testing

```bash
# Lighthouse audit
npm install -g lighthouse

lighthouse http://localhost:5173 --output-path=./lighthouse.html

# Target scores: 90+/100 (except PWA may be 70)
```

**Expected metrics:**
- First Contentful Paint: <2s
- Largest Contentful Paint: <4s
- Cumulative Layout Shift: <0.1
- Time to Interactive: <5s

---

## 4. WEB DEPLOYMENT

### 4.1 Static Host (Vercel/Netlify)

```bash
# Build
npm run build

# Vercel deployment
npm install -g vercel
vercel --prod

# Netlify deployment
npm install -g netlify-cli
netlify deploy --prod --dir=dist
```

### 4.2 Custom Host (VPS)

```bash
# Build locally
npm run build

# Upload to server
scp -r dist/* user@server.com:/var/www/librelog/

# Configure nginx
server {
  listen 443 ssl http2;
  server_name app.librelog.com;

  ssl_certificate /etc/letsencrypt/live/app.librelog.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.librelog.com/privkey.pem;

  root /var/www/librelog;

  # SPA routing
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Cache static assets
  location /assets/ {
    expires 1y;
    add_header Cache-Control "immutable";
  }

  # Service worker
  location /service-worker.js {
    add_header Cache-Control "max-age=0, must-revalidate";
  }

  # CSP + security headers
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://world.openfoodfacts.org https://fdc.nal.usda.gov https://api.openai.com https://api.anthropic.com";
  add_header X-Content-Type-Options "nosniff";
  add_header X-Frame-Options "DENY";
  add_header Referrer-Policy "strict-origin-when-cross-origin";
}
```

### 4.3 SSL Certificate (Let's Encrypt)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Issue certificate
sudo certbot certonly --webroot -w /var/www/librelog \
  -d app.librelog.com -d librelog.com

# Auto-renewal
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
```

---

## 5. NATIVE APP BUILDS

### 5.1 iOS Build

#### Preparation

```bash
# Update Capacitor files
npm run build
npx cap sync ios

# Open Xcode
open ios/App/App.xcworkspace

# In Xcode:
# 1. Select "App" in Project Navigator
# 2. Targets → "App" → General
# 3. Set Bundle ID: com.libre.librelog
# 4. Set Team ID (Apple Developer account)
# 5. Set Version (e.g., 1.0.0)
# 6. Set Build Number (e.g., 1)
```

#### Development Build

```bash
# Build for simulator
xcodebuild -scheme App -configuration Debug -derivedDataPath build \
  -destination 'generic/platform=iOS Simulator'

# Or via Xcode: Product → Build
```

#### Production Build

```bash
# Archive for App Store
xcodebuild -scheme App -configuration Release -derivedDataPath build \
  -archivePath build/App.xcarchive archive

# Create IPA
xcodebuild -exportArchive -archivePath build/App.xcarchive \
  -exportOptionsPlist exportOptions.plist \
  -exportPath build/ipa
```

#### App Store Connect

```bash
# Upload to App Store Connect
# 1. Create App in App Store Connect (https://appstoreconnect.apple.com)
# 2. Upload build via Xcode Organizer
# 3. Fill TestFlight beta info
# 4. Submit for review
# 5. Wait 1-3 days for review decision
```

### 5.2 Android Build

#### Preparation

```bash
# Update Capacitor files
npm run build
npx cap sync android

# Open Android Studio
open -a "Android Studio" android/
```

#### Generate Signing Key

```bash
# Create keystore (one-time)
keytool -genkey -v -keystore release.keystore \
  -alias librelog \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000

# Store securely; never commit to git
```

#### Development Build

```bash
# Build APK for testing
cd android
./gradlew assembleDebug

# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

#### Release Build

```bash
# Create signed APK
cd android
./gradlew assembleRelease

# Or build AAB for Play Store
./gradlew bundleRelease

# Outputs:
# - app/build/outputs/apk/release/app-release.apk
# - app/build/outputs/bundle/release/app-release.aab
```

#### Google Play Store

```bash
# 1. Create Google Play Console account ($25 one-time)
# 2. Create app: com.libre.librelog
# 3. Upload AAB (preferred for Play Store)
# 4. Fill store listing (description, screenshots, privacy policy)
# 5. Set up beta testing track
# 6. Submit for review
# 7. Wait 1-3 days for review
```

---

## 6. RELEASE PROCESS

### 6.1 Version Numbering

**Format:** `MAJOR.MINOR.PATCH-[PRERELEASE]`

```
v1.0.0       # Initial release (MVP)
v1.1.0       # New features (Enhanced phase)
v1.1.1       # Bug fix
v1.2.0-beta  # Pre-release
```

### 6.2 Pre-Release Checklist

**1 week before release:**

```bash
# 1. Bump version in package.json
npm version minor  # or patch/major

# 2. Update CHANGELOG.md
- Added: Photo analysis (BYOK)
- Fixed: Weight trend calculation
- Changed: UI for meal quick-add

# 3. Run full test suite
npm run test -- --coverage

# 4. Build and test locally
npm run build
npm run preview

# 5. Create beta build for testing
npm run build
npx cap sync ios
npx cap sync android
# Test in iOS Simulator + Android Emulator

# 6. Tag release candidate
git tag -a v1.0.0-rc1 -m "Release candidate 1"
git push origin v1.0.0-rc1
```

### 6.3 Production Release

```bash
# 1. Final build
npm run build

# 2. Deploy web
vercel --prod  # or netlify deploy --prod

# 3. Submit iOS to App Store
# (via Xcode + App Store Connect)

# 4. Submit Android to Play Store
# (via Google Play Console)

# 5. Create GitHub release
git tag -a v1.0.0 -m "Release v1.0.0: MVP meal tracker"
git push origin v1.0.0
git push origin main

# 6. GitHub release page
# - Include changelog
# - Attach web build (zip dist/)
# - Link to app stores
```

### 6.4 Release Announcement

**Channels:**
- GitHub Releases page
- Project website
- Open source communities (Reddit, HackerNews)
- Social media

**Template:**
```
LibreLog v1.0.0 Released

🎉 Initial release of LibreLog, an open-source meal tracker and calorie counter.

🚀 Features:
- Offline-first meal diary (iOS, Android, web PWA)
- 1000+ foods from Open Food Facts API
- Barcode scanning
- Weight tracking with trends
- Export/backup to WebDAV

📱 Available on:
- Web: https://app.librelog.com
- iOS App Store
- Google Play Store

📜 License: AGPL-3.0
🔗 Source: https://github.com/libre-suite/librelog

---
Changelog: https://github.com/libre-suite/librelog/releases/tag/v1.0.0
```

---

## 7. MONITORING & UPDATES

### 7.1 Error Tracking

```javascript
// src/utils/error.js
export function initErrorTracking() {
  // Option 1: Sentry (self-hosted or cloud)
  import * as Sentry from "@sentry/browser";

  Sentry.init({
    dsn: "https://xxx@sentry.io/xxx",
    environment: process.env.NODE_ENV,
    release: "1.0.0",
    beforeSend(event) {
      // Filter out sensitive data
      if (event.request) {
        delete event.request.cookies;
      }
      return event;
    }
  });

  // Option 2: Self-hosted error logging
  window.addEventListener('error', (event) => {
    logError({
      message: event.message,
      stack: event.error?.stack,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent
    });
  });
}

async function logError(error) {
  try {
    // Only with user opt-in
    const allowAnalytics = await db.get('users', 'user-1').allowAnalytics;
    if (!allowAnalytics) return;

    await fetch('https://logs.librelog.com/errors', {
      method: 'POST',
      body: JSON.stringify(error)
    });
  } catch (e) {
    // Fail silently
  }
}
```

### 7.2 Analytics (Optional)

```javascript
// Only basic, anonymized metrics
// No personal data tracked

import { analytics } from '@capacitor-firebase/analytics';

export async function trackEvent(event, params = {}) {
  const allowAnalytics = await db.get('users', 'user-1')?.allowAnalytics;
  if (!allowAnalytics) return;

  // Remove any PII
  const sanitizedParams = Object.fromEntries(
    Object.entries(params).filter(([k]) =>
      !['name', 'location', 'notes'].includes(k)
    )
  );

  analytics.logEvent({
    name: event,
    params: sanitizedParams
  });
}

// Track only non-sensitive actions
trackEvent('meal_logged', { mealType: 'lunch' });
trackEvent('app_opened');
trackEvent('settings_changed', { setting: 'theme' });
```

### 7.3 Update Strategy

```bash
# Check for updates (PWA auto-updates service worker)
# Notify user: "Update available, tap to refresh"

// src/app.js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(reg => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated') {
          showNotification('Update available. Refresh to apply.');
        }
      });
    });
  });
}
```

---

## 8. TROUBLESHOOTING

### Common Issues

| Issue | Solution |
|-------|----------|
| **iOS build fails: "Pod not found"** | `cd ios && pod install && cd ..` |
| **Android build fails: "SDK not found"** | Set `ANDROID_HOME` env variable |
| **PWA not offline** | Check service worker registration in DevTools |
| **IndexedDB quota exceeded** | Implement cache cleanup (expiry) |
| **Barcode scanning doesn't work** | Check camera permissions in manifest |
| **Sync fails** | Verify WebDAV credentials, network access |

### Debug Logs

```javascript
// Enable debug mode
localStorage.setItem('DEBUG', 'true');

// View logs in console
const debug = localStorage.getItem('DEBUG') === 'true';
if (debug) console.log('Meal logged:', meal);

// Disable in production
console.log = process.env.NODE_ENV === 'production' ? () => {} : console.log;
```

---

## 9. DEPLOYMENT CHECKLIST

Before each release:

**Code Quality:**
- [ ] All tests passing
- [ ] No console.error or warnings
- [ ] No sensitive data in logs
- [ ] Dependencies up-to-date
- [ ] Bundle size <100KB gzip

**Security:**
- [ ] CSP headers set
- [ ] HTTPS enforced
- [ ] No unencrypted BYOK keys
- [ ] Input validation in place
- [ ] XSS/injection tests passing

**Performance:**
- [ ] Lighthouse score 90+
- [ ] Page load <2s
- [ ] Smooth animations
- [ ] Offline mode functional

**Documentation:**
- [ ] README up-to-date
- [ ] CHANGELOG entries added
- [ ] Privacy policy reviewed
- [ ] Screenshots/GIFs updated

**Release:**
- [ ] Version bumped
- [ ] Git tag created
- [ ] Web deployed
- [ ] iOS submitted
- [ ] Android submitted
- [ ] Release notes published

---

This deployment guide covers:
- Development setup
- Build optimization
- Testing procedures
- Web hosting options
- Native app builds
- Release process
- Monitoring & updates
- Troubleshooting
