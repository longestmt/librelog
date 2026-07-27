# LibreLog Release-Candidate Audit

Audit date: 2026-07-27

Audited version: `0.3.0`
Scope: web/PWA source, local persistence, integrations, backup/import/export, responsive UI, and Capacitor configuration

## 1. Product, users, principles, and architecture

LibreLog is a local-first meal tracker for people who want quick calorie and
macronutrient logging without a required subscription or hosted account. Its
core workflows are:

1. Find, scan, describe, photograph, or manually enter a food.
2. Review the portion and nutrition before logging it.
3. Edit or remove an entry and review progress against personal targets.
4. Re-log recent foods, copy a day, load a meal template, or log a recipe.
5. Review daily, weekly, monthly, and weight trends.
6. Export, import, automatically back up, or restore the local data.

The intended product principles are local ownership, calm and neutral language,
low visual stimulation, explicit user review, portable data, and provider
choice. AI estimates are a first-class input method, but are approximate,
labelled, assumption-bearing, and editable rather than authoritative.

The application is a vanilla JavaScript single-page app built by Vite and
packaged as a PWA. IndexedDB is the source of truth. It contains foods, meals,
recipes, templates, measurements, settings, usage records, and related local
data. Open Food Facts and USDA supply optional remote food results. OpenAI,
Anthropic, and local Ollama are bring-your-own-provider estimation options.
WebDAV is an explicit backup/restore transport, not multi-device conflict-aware
sync. Capacitor dependencies and configuration exist, but native platform
projects were not present in the audited repository.

Privacy boundary:

- Meal and weight data stay in IndexedDB unless the user exports, backs up, or
  invokes a remote food/AI integration.
- A selected AI provider receives the submitted description and/or image.
- API and WebDAV credentials are currently stored as plaintext settings in the
  browser/app profile. This is disclosed in the UI and security documentation.
- Portable exports and remote backups now exclude credential fields.

## 2. Baseline

### Repository and environment

- Existing logo/favicon work and other unrelated uncommitted files were
  preserved during the initial audit. The user later approved the logo work.
- Runtime: Node `24.18`, npm `11.16`.
- Detected build stack: Vite `6.4.2`, `vite-plugin-pwa` `0.21.2`, Capacitor
  `8.3.0`, Quagga2 `1.12.1`.
- There was no lint, type-check, or automated test command at baseline.
- The pre-change production build succeeded.
- `npm ls --all` completed without an invalid installed dependency tree.
  Reported unmet packages were platform/feature-specific optional dependencies.
- `node --check` succeeded on the JavaScript source.
- `npm audit --omit=optional --json` could not be completed: the sandbox had no
  registry DNS access and permission to transmit dependency metadata outside
  the sandbox was not granted. This is a release-environment gate, not evidence
  of a clean vulnerability report.

The repository is currently on Vite 6, which remains in Vite's security-patch
support window. A broad framework upgrade was therefore not justified by this
audit. See the official [Vite release support policy](https://vite.dev/releases).

### Baseline browser evidence

The production UI was exercised at desktop and mobile widths. Captures are in
`audit-artifacts/baseline-diary-desktop.png` and
`audit-artifacts/baseline-diary-mobile.png`.

Reproducible baseline failures included:

- On local 2026-07-27, the diary rendered 2026-07-26 because a bare calendar
  date was interpreted through UTC.
- Navigating to a prior day and choosing “Add Lunch” lost the target date, so a
  completed entry would be recorded on today.
- Selecting the built-in “Egg, large” defaulted to quantity 100 and previewed
  7,000 kcal instead of one large egg.
- A local food match was withheld for roughly 8.5 seconds while remote
  databases completed.
- Settings import passed parsed JSON into a file-only importer and could not
  complete the advertised restore path.
- WebDAV settings called functions/config keys that did not match the WebDAV
  module and presented remote replacement without a dedicated confirmation.

## 3. Findings and resolution

This section uses ASD-STE100-style controlled technical English.

The text uses short sentences, active voice, and one action in each instruction.
Technical nouns include names from the LibreLog source code.
The source is [ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf).
This audit does not claim formal ASD-STE100 certification.

### P0 — critical security, privacy, or data-loss risks

#### P0-01: Stored script injection

- **Problem:** Untrusted values could add executable markup to the user interface.
- **Evidence:** A malicious backup record could put markup in a toast or an HTML template.
- **Files:** `src/components/toast.js`, Settings, Diary, Search, Recipes, Weight, and Insights.
- **Change:** Put toast text in `textContent`.
- **Change:** Escape or normalize each untrusted value before display.
- **Change:** Limit goal and measurement values before display.
- **Verification:** The production build and browser checks pass.

#### P0-02: Credentials in exported data

- **Problem:** A data export included API keys and WebDAV credentials.
- **Evidence:** Save a credential. Export the JSON data. The credential occurs in the baseline file.
- **Files:** `src/data/db.js` and all backup workflows.
- **Change:** Remove all credential fields from exports and backups.
- **Change:** Add `secretsExcluded: true` to each backup.
- **Verification:** The backup tests pass.

#### P0-03: Partial data loss during import

- **Problem:** An import could clear data before it found an invalid record.
- **Evidence:** Put an invalid record after valid records in a replacement import.
- **Files:** `src/data/db.js`, Settings import, and WebDAV restore.
- **Change:** Validate the complete backup before a database change.
- **Change:** Limit the permitted record quantity.
- **Change:** Use one transaction for all store replacements.
- **Change:** Keep local credentials during a replacement.
- **Verification:** Five backup validation tests pass.

No known reproducible P0 remains.

### P1 — primary-workflow, correctness, and reliability problems

#### P1-01: Incorrect local dates

- **Problem:** UTC conversion could move a calendar date to the prior local day.
- **Evidence:** On July 27, the baseline diary showed July 26.
- **Files:** Date utilities, Diary, Search, Insights, and import code.
- **Change:** Parse each `YYYY-MM-DD` value as a local calendar date.
- **Change:** Use calendar operations for day changes.
- **Change:** Keep the selected date in each log link.
- **Verification:** Date and daylight-saving-time tests pass.
- **Verification:** The browser logged an egg on July 26 and returned to July 26.

#### P1-02: Incorrect count servings

- **Problem:** The application used 100 as the default quantity for a count serving.
- **Evidence:** One large egg showed 7,000 kcal.
- **Files:** `src/pages/search.js` and `src/engine/nutrition.js`.
- **Change:** Use the declared quantity for a count serving.
- **Change:** Convert mass units independently.
- **Verification:** One large egg shows 70 kcal.
- **Verification:** The serving tests pass.

#### P1-03: Incorrect sodium conversion

- **Problem:** Open Food Facts sodium values were 100 times too small.
- **Evidence:** The code multiplied grams by 10 instead of 1,000.
- **File:** `src/integrations/openfoodfacts.js`.
- **Change:** Convert sodium grams to milligrams.
- **Verification:** The sodium test passes.
- **Reference:** [Open Food Facts nutrition data](https://openfoodfacts.github.io/openfoodfacts-server/dev/explain-nutrition-data/).

#### P1-04: Unknown nutrients shown as zero

- **Problem:** The application changed some unknown nutrient values to zero.
- **Evidence:** Records without a nutrient produced a numeric zero.
- **Files:** Nutrition engine and food integrations.
- **Change:** Keep `null` for each unknown source value.
- **Change:** Keep unknown values during serving calculations.
- **Change:** Show a partial-data message in the diary.
- **Verification:** Open Food Facts, USDA, and total tests pass.

#### P1-05: Incorrect import and export operation

- **Problem:** Settings used the wrong input type for a JSON import.
- **Problem:** One export action could start more than one download.
- **Files:** `src/data/io.js`, `src/pages/settings.js`, and `src/data/db.js`.
- **Change:** Send the selected `File` to the importer.
- **Change:** Make one file for each export action.
- **Change:** Limit the file size.
- **Change:** Validate the data structure.
- **Verification:** Backup tests and browser checks pass.

#### P1-06: Incorrect WebDAV backup controls

- **Problem:** Settings used names that did not agree with the WebDAV module.
- **Problem:** The restore control did not give a sufficient replacement warning.
- **Files:** `src/data/webdav.js` and Settings.
- **Change:** Use one WebDAV configuration interface.
- **Change:** Convert old configuration keys when the application reads them.
- **Change:** Identify the operations as backup and restore.
- **Change:** Get confirmation before a restore.
- **Change:** Stop a browser request after the time limit.
- **Verification:** The Settings browser check passes.

#### P1-07: Unsafe AI response processing

- **Problem:** AI response data did not have a strict validation boundary.
- **Problem:** Cancellation did not stop all AI requests.
- **Problem:** Ollama could use an arbitrary default model.
- **Files:** AI client, image processor, voice parser, and clarification engine.
- **Change:** Validate each AI response before use.
- **Change:** Limit each text and numeric field.
- **Change:** Send cancellation and timeout signals to each provider request.
- **Change:** Require the user to specify an installed Ollama model.
- **Verification:** The deterministic AI tests pass.
- **Reference:** [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs).

#### P1-08: AI estimates were difficult to correct

- **Problem:** A user could log an AI result without sufficient review information.
- **Files:** AI search and review controls.
- **Change:** Identify each result as an estimate.
- **Change:** Show confidence, assumptions, and warnings.
- **Change:** Let the user change the serving and macro values.
- **Change:** Keep each user change after provider processing.
- **Verification:** The AI review browser check passes.

#### P1-09: Slow and stale search results

- **Problem:** Search waited for remote results before it showed local results.
- **Problem:** An old request could replace a new result.
- **Files:** `src/pages/search.js` and the application router.
- **Change:** Show local results first.
- **Change:** Add remote results when they become available.
- **Change:** Reject results from an old request.
- **Change:** Stop active page resources during navigation.
- **Verification:** The local egg result appeared in approximately 0.55 seconds.

#### P1-10: Duplicate entries and accidental deletion

- **Problem:** Repeated input could create duplicate records.
- **Problem:** One input action could delete an entry.
- **Problem:** A diary edit could remove fiber and sodium values.
- **Files:** Diary, Search, Recipes, and Weight.
- **Change:** Prevent a second save while the first save is active.
- **Change:** Route new food, AI, and recipe meal writes through one command.
- **Change:** Give each new meal command an idempotency key.
- **Change:** Require a second confirmation action before deletion.
- **Change:** Keep all nutrient values during an edit.
- **Verification:** The idempotency unit test passes.
- **Verification:** Diary, Recipe, and Weight browser checks pass.

#### P1-11: Old route content could replace new content

- **Problem:** A slow route could write to the main element after navigation.
- **Files:** `src/app.js` and page renderers.
- **Change:** Make a new main element for each navigation.
- **Change:** Wait for the initial page render before the route is ready.
- **Change:** Ignore a page completion after a newer route starts.
- **Change:** Stop resources from the prior page.
- **Change:** Keep late output in the detached old element.
- **Verification:** Chromium, Firefox, and WebKit route checks pass.

#### P1-12: Invalid goal and measurement values

- **Problem:** Invalid imported values could damage calculations or trend displays.
- **Files:** Goal tracking, Weight, and Insights.
- **Change:** Limit each numeric value to its permitted range.
- **Change:** Permit only known date and unit formats.
- **Verification:** The build and browser checks pass.

### P2 — usability, accessibility, and polish

#### P2-01: Route and modal focus

- **Problem:** The page had more than one main landmark.
- **Problem:** A closed modal did not return focus to the prior control.
- **Change:** Use one named main element.
- **Change:** Move focus to the main element after navigation.
- **Change:** Return focus after a modal closes.
- **Verification:** The semantic browser check passes.

#### P2-02: Insights tab semantics

- **Problem:** A visual tab change did not change `aria-selected`.
- **Change:** Update the tab state and panel name together.
- **Change:** Remove inactive tabs from the tab order.
- **Change:** Add Left, Right, Home, and End key controls.
- **Verification:** The keyboard browser check passes.

#### P2-03: Incorrect and stressful Insights data

- **Problem:** Averages included days without log data.
- **Problem:** Some rows showed internal food identifiers.
- **Problem:** Streak and fire text added pressure.
- **Change:** Calculate averages from logged days.
- **Change:** Show food names.
- **Change:** Use neutral activity text.
- **Verification:** Today, week, and month browser checks pass.

#### P2-04: Unclear target language

- **Problem:** A negative value could have the label “remaining.”
- **Problem:** Sodium text could appear as universal medical guidance.
- **Change:** Use “above target” for a negative remaining value.
- **Change:** Compare sodium only with the user-selected limit.
- **Verification:** Diary and Insights browser checks pass.

#### P2-05: Incorrect privacy information

- **Problem:** Settings implied that credential storage had more protection than it had.
- **Problem:** A secret input showed its stored value.
- **Change:** Tell the user that LibreLog does not encrypt stored credentials.
- **Change:** Keep each secret input empty after page load.
- **Change:** Explain the limit of same-profile browser backups.
- **Verification:** The Settings browser check passes.

#### P2-06: Development HTTPS

- **Problem:** The development server always used a self-signed certificate.
- **Change:** Use HTTP as the default development mode.
- **Change:** Use `LIBRELOG_HTTPS=1` to select local HTTPS.
- **Verification:** Development and production servers start correctly.

#### P2-07: Inconsistent accessible names

- **Problem:** Some primary controls did not have consistent names or regions.
- **Change:** Add headings, labels, names, and regions to primary workflows.
- **Verification:** The primary semantic browser check passes.

#### P2-08: Incomplete product identity

- **Problem:** The application shell and install assets used different marks.
- **Change:** Use one muted fork-and-ring mark for the shell and install assets.
- **Change:** Add 32, 192, and 512 pixel raster assets.
- **Change:** Add one vector shell asset.
- **Change:** Add a Chromium visual comparison for the rendered shell mark.
- **Verification:** The logo asset and browser checks pass.

### P3 — opportunities, not release blockers

- Add versioned data schemas and database migrations.
- Add encrypted portable backups.
- Add native keychain storage.
- Add favorites and saved servings.
- Add a meal history page.
- Add optional live-provider tests.
- Add multi-device synchronization only after user research confirms the need.

## 4. AI estimation evaluation

`test/fixtures/ai-estimates.json` is the deterministic recorded corpus. It
covers:

- simple explicit food/count;
- vague handful with an exposed serving assumption;
- packaged/tin serving;
- photo-derived gram portion;
- mixed meal;
- restaurant-style burger and fries;
- multiple servings;
- a corrected preparation detail;
- accepted low-confidence ambiguity with a warning;
- missing required macros;
- negative nutrition;
- implausibly large portions.

`test/ai-evaluation.test.js` evaluates the full fixture corpus without provider
calls. `test/ai-validation.test.js` separately checks shapes, required fields,
finite/ranged numbers, item-count limits, confidence warnings, calorie/macro
consistency warnings, text bounding, and rejected malformed responses.

The tests intentionally do not claim clinical or database-level accuracy. For
cases where the fixture represents a trustworthy declared serving, they verify
the expected serving and calories. For subjective mixed/restaurant/photo cases,
they verify separation of items, plausible bounded structure, explicit
assumptions, confidence behavior, and editability metadata.

Provider prompts mark meal descriptions as untrusted data and request JSON.
Returned JSON is still treated as untrusted and must pass local validation.
OpenAI JSON mode remains compatible with the configured `gpt-4o` chat workflow;
new provider work should prefer schema-constrained structured outputs where the
chosen endpoint/model supports it. See the official
[OpenAI model catalog](https://platform.openai.com/docs/models/) and
[backward-compatibility guidance](https://platform.openai.com/docs/api-reference/backward-compatibility).

Normal checks never make paid calls. An optional future live evaluation should
be a separate, explicitly enabled command that records provider/model/version,
uses a low spend cap, redacts credentials, and compares only against documented
tolerances. It should never run in the default test command.

## 5. Implemented changes and validation

Implemented work includes:

- local calendar-date utilities and historical-date propagation;
- unit-aware serving scaling and unknown-nutrient preservation;
- corrected OFF sodium and USDA missing/zero normalization;
- safe rendering and bounded settings/goals/measurements;
- validated, atomic, credential-excluding backup/import/restore;
- corrected WebDAV configuration and confirmation UX;
- deterministic AI response validation, assumptions, confidence, warnings,
  correction UI, cancellation, timeouts, and duplicate guards;
- faster local-first search with stale-response protection;
- full-nutrient edits, confirmation-based deletion, and guarded submissions;
- route cleanup/fresh-container isolation;
- calmer insights language and logged-day averages;
- responsive/accessibility polish and accurate privacy/security copy;
- a default `npm test` and combined `npm run check`.

Final automated result:

```text
npm run check
  41 unit and fixture tests passed, 0 failed
  13 Chromium workflow, accessibility, and visual tests passed, 0 failed
  Vite production build passed
  45 modules transformed
  PWA precache: 18 entries, 425.94 KiB
  main JS: 176.83 KiB (46.65 KiB gzip)
  CSS: 75.80 KiB (10.85 KiB gzip)

npm run test:e2e:all
  Chromium, Firefox, and WebKit workflows passed
  35 tests passed
  4 browser-specific tests skipped
  Offline-PWA control and the logo image comparison ran in Chromium only

git diff --check
  passed

npm ls --all
  completed; installed tree valid (platform/feature optional packages omitted)

npm audit
  0 vulnerabilities
```

Final browser result on an uncached production preview:

- Desktop 1440 × 1000 and mobile 390 × 844 diary layouts were visually checked.
- The new fork-and-ring logo rendered at 32 × 32 in the desktop shell.
- The 32, 192, and 512 pixel install assets loaded from the production build.
- Final captures:
  `audit-artifacts/final-diary-desktop.jpg` and
  `audit-artifacts/final-diary-mobile.jpg`.
- Diary displayed local Monday, July 27.
- Historical add preserved July 26 and returned to that diary after logging.
- Local egg search appeared before remote results; one large egg previewed and
  logged as 70 kcal, 6 g protein, 0.5 g carbohydrate, and 5 g fat.
- Two-step removal deleted the item without leaving stale totals.
- A recipe was created with one egg, saved, and logged to breakfast; empty
  recipes were rejected.
- Today/week/month Insights rendered correct food names and logged-day averages.
- Weight add/stats/delete completed, including confirmation.
- Settings rendered the credential disclosure, blank secret inputs, backup and
  restore actions, and disconnected WebDAV state.
- The AI journey was configured against local Ollama with a deliberately
  unavailable model. It rendered the approximate-estimate disclosure, entered a
  stable error state, and offered “Try Again” without creating a meal or making
  a paid request.
- Single main landmark, route focus, labelled controls, dialog focus behavior,
  and primary semantic regions were inspected. Insights tab state was found and
  corrected during this pass; arrow-key navigation and selected/panel state were
  rechecked on a fresh origin.
- Playwright now repeats the historical meal, recipe, backup, Insights, CSP,
  manifest, and offline-PWA workflows.
- Axe now checks Diary, Insights, Weight, Recipes, Settings, and the mobile
  diary for detectable WCAG A and AA violations.
- The accessibility tests found and prevented low-contrast Settings text, an
  indistinct attribution link, and incorrect theme-token scope.

## 6. Remaining risks and known limitations

1. **Live integrations not fully certified:** no real OpenAI, Anthropic, USDA,
   WebDAV, camera, microphone, or barcode hardware credential/session was
   available. Local deterministic substitutes and UI/error paths were used.
2. **Plaintext secrets:** BYOK/WebDAV credentials remain readable to code with
   the same browser profile/origin and to a compromised device account. The UI
   states this accurately. One credential interface now isolates storage
   access. Native keychain storage remains recommended work.
3. **Native release unverified:** no `ios/` or `android/` platform project was
   present. Capacitor build, permissions, camera/microphone behavior, secure
   storage, store signing, and device accessibility require separate platform
   validation. The current Capacitor configuration does not permit cleartext
   traffic.
4. **WebDAV is backup/restore:** it has no revisions, merge semantics, or
   cross-device conflict resolution. A newer local state can be replaced by an
   older confirmed backup.
5. **Browser automatic backup independence:** local browser backups share the
   browser profile and are not protection against profile/device loss.
6. **Deployment headers:** The document has a baseline CSP and `no-referrer`
   policy. HSTS, `X-Content-Type-Options`, Permissions Policy, and frame
   protection remain hosting responsibilities.
7. **Nutrition source variability:** remote records may have incomplete,
   outdated, or differently defined serving data. Unknowns are now preserved,
   and recipes identify incomplete aggregate values.
8. **Model/provider lifecycle:** configured model names and response behavior
   can change. Compatibility needs periodic smoke checks; do not silently
   switch a user's provider/model.
9. **Automation depth:** Chromium, Firefox, and WebKit workflows run for pull
   requests. Chromium also checks the logo image and the offline PWA. A native
   device and full-page visual-difference matrix does not exist.
10. **Remote performance/offline:** remote search depends on public APIs and
    their rate/availability policies. Local results and cached data remain
    usable, but remote pagination/retry/backoff is basic.
11. **Fonts:** remote web fonts may not load offline; system fallbacks preserve
    usability and should remain acceptable by design.

## 7. Prioritized roadmap

### Completed release work

1. Run the dependency security scan.
2. Remove all reported dependency vulnerabilities.
3. Add Playwright tests for historical log operations.
4. Add Playwright tests for recipe log operations.
5. Add Playwright tests for clean-profile backup replacement.
6. Add axe tests to the primary pages.
7. Add a baseline document CSP.
8. Add a no-referrer policy.
9. Add an offline PWA test.
10. Compare exported and imported backup data.
11. Run all release checks before GitHub Pages deployment.
12. Run Chromium, Firefox, and WebKit checks for each pull request.
13. Add a visual comparison for the new logo.
14. Replace the shell, favicon, and install icons with one product mark.
15. Remove cleartext traffic from the Capacitor release configuration.
16. Add a meal command for new food, AI, and recipe writes.
17. Add an idempotency key to each new meal command.

### Remaining immediate work

1. Get user consent before each live integration test.
2. Use disposable data for each live integration test.
3. Set an API cost limit for each live AI test.
4. Set strict response headers on a host that supports them.
5. Create the native platform projects before a native release.

### Medium-term architecture

Completed:

1. Add version numbers to stored data and backup schemas.
2. Add a version number to each normalized AI result.
3. Put credential operations in one storage adapter.
4. Add the first meal command boundary.
5. Add idempotency keys to new food, AI, and recipe meal writes.

Remaining:

1. Use an operating-system keychain on native platforms.
2. Add optional encrypted credential storage for the web application.
3. Move edit, remove, import, copy, and template meal operations to commands.
4. Add an idempotency token to each remaining write command.
5. Define one interface for each remote integration.
6. Use consistent timeout and cancellation errors.
7. Remove meal data from diagnostic logs.
8. Add small IndexedDB migrations.
9. Make a backup before each data migration.
10. Keep a rollback operation for each migration.

### Optional product opportunities

1. Add favorites and saved servings.
2. Add a searchable meal history.
3. Add first-use privacy information.
4. Add a backup reminder.
5. Add optional encrypted WebDAV backups.
6. Add conflict-aware synchronization only after user research confirms the need.

## 8. Feature proposals

### Favorites and saved servings

- **Problem:** A frequent food can still require a search.
- **Change:** Let the user save a usual serving for a food.
- **Value:** The user can log the food with one or two actions.
- **Effort:** Medium.
- **Cost:** This feature has no hosted service cost.
- **Risk:** The feature adds food metadata and management controls.

### Searchable meal history

- **Problem:** Quick re-log does not find an old meal by date or name.
- **Change:** Add a searchable local meal history.
- **Change:** Show a meal preview before reuse.
- **Value:** The user can verify a meal before the user logs it again.
- **Effort:** Medium.
- **Cost:** This feature has no hosted service cost.
- **Risk:** The search must keep correct date and serving data.

### First-run privacy information

- **Problem:** A user might not know when data goes to a remote provider.
- **Change:** Show provider-specific privacy information during first use.
- **Change:** Show how LibreLog stores each credential.
- **Value:** The user can give informed consent.
- **Effort:** Small to medium.
- **Cost:** Keep the text correct when an integration changes.
- **Risk:** Too much text can make first use difficult.

### Recipe partial-data information

- **Status:** Implemented.
- **Problem:** A recipe can appear complete when an ingredient has unknown nutrients.
- **Change:** Identify unknown nutrients at the ingredient level.
- **Change:** Keep the additional information closed by default.
- **Value:** Recipe totals give more accurate information.
- **Effort:** Small.
- **Cost:** The user interface gets more status information.
- **Risk:** Too much status information can add visual noise.

### Optional encrypted backup

- **Problem:** A backup can contain sensitive meal and weight data.
- **Change:** Add passphrase encryption to portable and WebDAV backups.
- **Value:** Encryption protects backup data outside the application profile.
- **Effort:** Medium to large.
- **Cost:** This feature needs format maintenance and cryptographic review.
- **Risk:** LibreLog cannot recover a lost passphrase.

### Live provider conformance command

- **Problem:** A provider change can make an AI model incompatible.
- **Change:** Add a separate live conformance command.
- **Change:** Require explicit user selection for this command.
- **Change:** Set a maximum cost for each command operation.
- **Value:** Maintainers can find provider changes before a release.
- **Effort:** Medium.
- **Cost:** Each command operation can have a small API cost.
- **Risk:** Provider output is not deterministic.

## 9. Architecture proposals

### A. Versioned schemas and migrations

- **Status:** Schema versions are implemented. Store migrations remain.
- **Problem:** Data rules occur in multiple page and engine files.
- **Change:** Define a versioned schema for each stored record.
- **Change:** Define a versioned schema for each provider response.
- **Sequence:** Add backup schemas first.
- **Sequence:** Add provider schemas second.
- **Sequence:** Add one store migration in each release.
- **Risk:** A strict schema can reject an unusual old record.
- **Rollback:** Keep the prior schema reader for one release.
- **Rollback:** Make a verified backup before the migration.

### B. Secret-storage adapter

- **Status:** The storage adapter is implemented. Secure platform backends remain.
- **Problem:** IndexedDB contains plaintext credentials.
- **Change:** Add one credential storage interface.
- **Change:** Use Keychain or Keystore on native platforms.
- **Change:** Use session storage as the default web option.
- **Change:** Add optional passphrase encryption.
- **Sequence:** Read an old credential one time.
- **Sequence:** Write the credential with the new interface.
- **Sequence:** Verify that the new interface can read the credential.
- **Sequence:** Get user confirmation before removal of the old credential.
- **Risk:** Browser encryption does not prevent a same-origin attack.
- **Risk:** LibreLog cannot recover a lost passphrase.
- **Rollback:** Keep the provider configuration and request the credential again.

### C. Meal command/service boundary

- **Status:** New food, AI, and recipe writes use the first command.
- **Problem:** Page code contains display, calculation, integration, and storage operations.
- **Change:** Add pure preview and validation functions.
- **Change:** Add transaction commands for meal changes.
- **Change:** Give each command a target date.
- **Change:** Give each write command an idempotency key.
- **Sequence:** Move new meal logging first.
- **Sequence:** Move edit and remove operations second.
- **Sequence:** Move recipe and template operations last.
- **Risk:** A large code change can damage current data behavior.
- **Rollback:** Move one command at a time.
- **Rollback:** Keep the old operation until comparison tests pass.

### D. Integration contract

- **Problem:** Integrations use different timeout, error, and configuration rules.
- **Change:** Define one result format.
- **Change:** Define one error format.
- **Change:** Use one cancellation interface.
- **Change:** Add privacy information to each integration definition.
- **Change:** Limit retry quantity and delay.
- **Sequence:** Apply the interface to AI providers first.
- **Sequence:** Apply the interface to food databases second.
- **Sequence:** Keep WebDAV backup rules separate.
- **Risk:** One common interface can hide a provider-specific function.
- **Rollback:** Keep each old provider function below its adapter.

### E. Release verification matrix

- **Status:** Chromium, Firefox, WebKit, axe, CSP, backup, offline-PWA, and logo
  tests are implemented.
- **Problem:** Browser, integration, PWA, and native checks are primarily manual.
- **Change:** Run unit tests for each change.
- **Change:** Run browser and accessibility tests for each pull request.
- **Change:** Run live provider tests only on request.
- **Change:** Run signed-device tests before each native release.
- **Sequence:** Automate the five primary browser workflows first.
- **Sequence:** Add one provider at a time.
- **Sequence:** Add one target platform at a time.
- **Risk:** Unstable public APIs can make tests unreliable.
- **Rollback:** Keep unstable external tests non-blocking.
- **Rollback:** Make a test blocking only after it meets the reliability target.

## 10. Release assessment and five highest-value investments

**Assessment:** The web/PWA code is a release candidate.
The production build passes.
The application starts correctly.
The changes keep the current data schema.
The deterministic tests pass.
No known reproducible P0 remains.
A native-store release is not certified.

The five highest-value next investments are:

1. **Production release validation**
   - Set strict response headers on a configurable production host.
   - Add full-page visual comparisons.
2. **Live integration tests**
   - Use disposable data.
   - Set an API cost limit.
   - Do a test of each remote integration.
3. **Native release preparation**
   - Create the native platform projects.
   - Add operating-system keychain storage.
   - Do device accessibility and permission tests.
4. **Backup protection**
   - Add optional encrypted backups.
5. **Data schemas and migrations**
   - Add small migrations.
   - Add a backup checkpoint before each migration.
