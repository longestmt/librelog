# LibreLog Security and Privacy

**Status:** implementation guide
**Updated:** July 2026

This document describes the current application, not a future design.

## Data flow

- Meals, foods, goals, recipes, measurements, settings, and API cache records
  are stored locally in IndexedDB.
- Browser auto-backups use localStorage. They improve recovery from an
  accidental application-level write, but are not independent of the same
  browser profile.
- Food search terms are sent to Open Food Facts and, when configured, USDA
  FoodData Central.
- Optional AI features send the user-selected description, audio, or photo to
  the configured OpenAI, Anthropic, or Ollama endpoint.
- Optional WebDAV sync sends a JSON backup to the server configured by the
  user.
- LibreLog has no account service, analytics, or first-party application
  backend.

## Credentials

AI, USDA, and WebDAV credentials are stored unencrypted in IndexedDB. This is
local storage, not a hardware-backed secret store. Anyone or any script with
access to the browser profile may be able to read them.

JSON exports, browser auto-backups, and WebDAV backups exclude credential
settings. Replacement imports preserve credentials already on the device and
ignore credentials included in an imported file.

Users should protect their operating-system account and browser profile, use
provider-side spending limits, and revoke a key if the device or profile is
compromised.

## Implemented controls

- Untrusted strings are escaped before insertion into HTML; toast messages use
  `textContent`.
- JSON backups are shape-checked before import and replacement runs in one
  multi-store IndexedDB transaction.
- AI nutrition responses pass deterministic type, range, count, and
  plausibility validation before they can be reviewed or logged.
- AI estimates retain confidence, assumptions, warnings, and an estimate source
  marker.
- Network requests use timeouts where supported by the integration.
- PWA cache rules cover static application assets and public food-database
  responses, not IndexedDB diary records or API credentials.

## Deployment requirements

The application document includes a baseline CSP and a `no-referrer` policy.
The CSP prevents external scripts, objects, and base-URL changes. Its
`connect-src` rule permits HTTP and HTTPS because users can configure AI and
WebDAV endpoints.

Production web deployments must use HTTPS. They must set stricter headers at the
host or reverse proxy:

- `Content-Security-Policy`: scope `connect-src` to the food and AI providers
  actually supported by that deployment. A user-defined Ollama/WebDAV endpoint
  requires an explicit policy decision.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy` restricting camera and microphone to the application
- frame protection through CSP `frame-ancestors 'none'`

GitHub Pages does not provide repository-level custom response headers. A
deployment that needs strict response headers must use a host or proxy that can
set them.

Capacitor currently permits cleartext traffic so a local HTTP Ollama server can
be used. Release builds that do not support local HTTP providers should disable
cleartext traffic.

## Reporting and release checks

Do not include meal data, photos, descriptions, credentials, or complete AI
responses in bug reports. Revoke exposed provider credentials immediately.

Before release:

1. Run `npm run check`.
2. Confirm that the Playwright clean-profile backup test passes.
3. Verify configured WebDAV and AI providers with non-production credentials.
4. Test camera/microphone permission denial and navigation cleanup.
5. Review `AUDIT.md` for accepted risks and environment-dependent checks.
