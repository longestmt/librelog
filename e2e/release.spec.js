import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

async function preparePage(page) {
  await page.addInitScript(() => localStorage.removeItem('librelog_add_draft_v1'));
  await page.route('**/cgi/search.pl**', route => route.abort());
  await page.route('**/api.nal.usda.gov/**', route => route.abort());
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.goto('/#/diary', { waitUntil: 'commit' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
}

async function logEggOnPreviousDay(page, meal = 'Lunch') {
  await preparePage(page);
  const todayLabel = await page.getByRole('navigation', { name: 'Date navigation' }).locator('.date-display').textContent();
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.locator('.date-display')).not.toHaveText(todayLabel);
  const historicalLabel = (await page.locator('.date-display').textContent()).trim();

  await page.getByRole('button', { name: `Add food to ${meal}` }).click();
  await expect(page).toHaveURL(/#\/search\?meal=.*&date=\d{4}-\d{2}-\d{2}$/);
  const targetDate = new URL(page.url()).hash.match(/date=(\d{4}-\d{2}-\d{2})/)?.[1];
  expect(targetDate).toBeTruthy();

  await page.getByRole('searchbox', { name: 'Search for foods' }).fill('egg');
  const eggResult = page.getByRole('button', { name: /Egg, large.*70 calories per/i }).first();
  await expect(eggResult).toBeVisible();
  await eggResult.click();

  const dialog = page.getByRole('dialog', { name: 'Egg, large' });
  await expect(dialog.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('1');
  await expect(dialog).toContainText('70 kcal');
  await dialog.getByRole('button', { name: 'Add to draft' }).click();
  await page.getByRole('button', { name: 'Review meal' }).click();
  await page.getByRole('dialog', { name: /Review lunch/i }).getByRole('button', { name: 'Save meal' }).click();

  await expect(page).toHaveURL(new RegExp(`#\\/diary\\?date=${targetDate}$`));
  await expect(page.getByRole('main', { name: 'Diary' })).toContainText(historicalLabel);
  await expect(page.getByRole('button', { name: /Egg, large, 1 large, 70 calories/i })).toBeVisible();
  return { targetDate, historicalLabel };
}

test('a weighted seeded egg uses its explicit count conversion', async ({ page }) => {
  await preparePage(page);
  await page.getByRole('button', { name: 'Add food to Lunch' }).click();
  await page.getByRole('searchbox', { name: 'Search for foods' }).fill('egg');
  await page.getByRole('button', { name: /Egg, large.*70 calories per/i }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Egg, large' });
  await dialog.getByRole('combobox', { name: 'Unit', exact: true }).selectOption('g');
  await dialog.getByRole('spinbutton', { name: 'Quantity' }).fill('50');
  await dialog.getByRole('spinbutton', { name: 'Quantity' }).press('Tab');
  await expect(dialog).toContainText('70 kcal');
  await dialog.getByRole('spinbutton', { name: 'Quantity' }).fill('0');
  await dialog.getByRole('button', { name: 'Add to draft' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('0');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('a delayed Add-to-draft action is single-flight and cannot close a newer dialog', async ({ page }) => {
  await preparePage(page);
  await page.getByRole('button', { name: 'Add food to Lunch' }).click();
  await page.getByRole('searchbox', { name: 'Search for foods' }).fill('egg');
  await page.getByRole('button', { name: /Egg, large.*70 calories per/i }).first().click();
  const portionDialog = page.getByRole('dialog', { name: 'Egg, large' });

  await page.evaluate(async () => {
    window.__draftTestLockHeld = false;
    window.__draftTestRelease = null;
    window.__draftTestLock = navigator.locks.request('librelog:add-draft:v1', async () => {
      window.__draftTestLockHeld = true;
      await new Promise(resolve => { window.__draftTestRelease = resolve; });
    });
    while (!window.__draftTestLockHeld) await new Promise(resolve => setTimeout(resolve, 0));
  });

  const addButton = portionDialog.getByRole('button', { name: 'Add to draft' });
  await addButton.evaluate(button => {
    button.click();
    button.click();
  });
  await expect(portionDialog.getByRole('button', { name: 'Adding…' })).toBeDisabled();
  await expect.poll(() => page.evaluate(async () => {
    const state = await navigator.locks.query();
    return state.pending.filter(lock => lock.name === 'librelog:add-draft:v1').length;
  })).toBe(1);
  await page.keyboard.press('Escape');
  await expect(portionDialog).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/settings'; });
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Export Encrypted Data' }).click();
  const newerDialog = page.getByRole('dialog', { name: 'Export Encrypted Data' });
  await page.evaluate(() => window.__draftTestRelease());
  await expect(page.getByRole('status').filter({ hasText: 'Egg, large added to the draft' })).toBeVisible();
  await expect(newerDialog).toBeVisible();
  await newerDialog.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/#/search', { waitUntil: 'commit' });
  await expect(page.locator('.add-draft-count')).toHaveText('1 item');
});

test('switching cloud AI providers requires a key for the new provider', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });
  const provider = page.getByRole('combobox', { name: 'AI provider' });
  await provider.selectOption('openai');
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('openai-test-key');
  await page.getByRole('checkbox', { name: 'I understand this remote data use.' }).first().check();
  await page.getByRole('button', { name: 'Save AI Settings' }).click();
  await expect(page.getByRole('status')).toContainText('AI configured with openai');

  await page.reload({ waitUntil: 'commit' });
  await expect(provider).toHaveValue('openai');
  await provider.selectOption('anthropic');
  await page.getByRole('checkbox', { name: 'I understand this remote data use.' }).first().check();
  await page.getByRole('button', { name: 'Save AI Settings' }).click();
  await expect(page.getByRole('status')).toContainText('Please enter a new API key for anthropic');

  await page.reload({ waitUntil: 'commit' });
  await expect(page.getByRole('combobox', { name: 'AI provider' })).toHaveValue('openai');
});

test('an edited AI estimate survives a direct pointer click on Add selected', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });
  await page.getByRole('combobox', { name: 'AI provider' }).selectOption('ollama');
  await page.locator('#ai-model').fill('release-test-model');
  await page.getByRole('button', { name: 'Save AI Settings' }).click();
  await expect(page.getByRole('status')).toContainText('AI configured with ollama');

  await page.route('**/api/chat', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      message: {
        content: JSON.stringify({
          foods: [{
            name: 'Rice bowl',
            quantity: 1,
            unit: 'bowl',
            calories: 300,
            protein: 8,
            carbs: 60,
            fat: 3,
            confidence: 0.95,
            assumptions: ['One standard bowl'],
          }],
        }),
      },
      prompt_eval_count: 10,
      eval_count: 5,
    }),
  }));
  await page.goto('/#/search?mode=ai', { waitUntil: 'commit' });
  await page.getByRole('textbox', { name: 'Describe your meal' }).fill('rice bowl');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByRole('heading', { name: 'Detected Foods' })).toBeVisible();

  await page.locator('.ai-food-edit[data-field="quantity"]').fill('2');
  const addSelected = page.getByRole('button', { name: 'Add selected (1)' });
  const box = await addSelected.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(page.locator('.add-draft-count')).toHaveText('1 item');
  await page.getByRole('button', { name: 'Review meal' }).click();
  const reviewDialog = page.getByRole('dialog', { name: /Review lunch/i });
  await expect(reviewDialog.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('2');
  await expect(reviewDialog).toContainText('600 kcal');
});

test('a package-label serving stays readable and unknown macros stay unknown through save', async ({ page }) => {
  await preparePage(page);
  await page.getByRole('button', { name: 'Add food to Lunch' }).click();
  await page.getByRole('button', { name: 'Add Custom Food' }).click();

  const labelDialog = page.getByRole('dialog', { name: 'Add food from a label' });
  await labelDialog.getByRole('textbox', { name: 'Food name' }).fill('Test crackers');
  await labelDialog.getByRole('textbox', { name: 'Serving label' }).fill('2 crackers');
  await labelDialog.getByRole('spinbutton', { name: 'Calories' }).fill('120');
  await labelDialog.getByRole('button', { name: 'Add Food' }).click();

  const portionDialog = page.getByRole('dialog', { name: 'Test crackers' });
  await expect(portionDialog).toContainText('Serving reference: 2 crackers');
  await expect(portionDialog.locator('.preview-stat').filter({ hasText: 'Protein' })).toContainText('Unknown');
  await portionDialog.getByRole('button', { name: 'Add to draft' }).click();

  await expect(page.locator('.add-draft-count')).toHaveText('1 item');
  await page.getByRole('button', { name: 'Scan barcode' }).click();
  await expect(page.locator('.add-draft-count')).toHaveText('1 item');
  await page.evaluate(() => { window.location.hash = '#/diary'; });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/search'; });
  await expect(page.getByRole('main', { name: 'Add Food' })).toBeVisible();
  await expect(page.locator('.add-draft-count')).toHaveText('1 item');

  await page.getByRole('button', { name: 'Review meal' }).click();
  const reviewDialog = page.getByRole('dialog', { name: /Review lunch/i });
  await expect(reviewDialog).toContainText('Protein unknown');
  await expect(reviewDialog).toContainText(/missing values are shown as unknown, not zero/i);
  await reviewDialog.getByRole('button', { name: 'Save meal' }).click();

  await expect(page.getByRole('button', { name: /Test crackers, 1 serving · 2 crackers, 120 calories/i })).toBeVisible();
  await expect(page.getByText('Partial nutrition:')).toBeVisible();
});

test('historical meal can be logged, edited, deleted, and restored without changing its date', async ({ page }) => {
  await logEggOnPreviousDay(page);

  await page.getByRole('button', { name: /Egg, large, 1 large, 70 calories/i }).click();
  const editDialog = page.getByRole('dialog', { name: 'Egg, large' });
  await editDialog.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await editDialog.getByRole('spinbutton', { name: 'Quantity' }).press('Tab');
  await expect(editDialog).toContainText('140 kcal');
  await editDialog.getByRole('button', { name: 'Update' }).click();
  await expect(page.getByRole('button', { name: /Egg, large, 2 large, 140 calories/i })).toBeVisible();

  await page.getByRole('button', { name: /Egg, large, 2 large, 140 calories/i }).click();
  const deleteButton = page.getByRole('dialog', { name: 'Egg, large' }).getByRole('button', { name: 'Delete' });
  await deleteButton.click();
  const confirmDeleteButton = page.getByRole('dialog', { name: 'Egg, large' })
    .getByRole('button', { name: 'Confirm removal of this food' });
  await expect(confirmDeleteButton).toBeVisible();
  await confirmDeleteButton.click();
  await expect(page.getByRole('button', { name: /Egg, large/ })).toHaveCount(0);
  await page.getByRole('status').filter({ hasText: 'Food removed' }).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /Egg, large, 2 large, 140 calories/i })).toBeVisible();
});

test('recipe uses the working yield when previewing and logging a serving', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/recipes', { waitUntil: 'commit' });
  await page.getByRole('button', { name: 'Create new recipe' }).click();
  await expect(page).toHaveURL(/#\/recipes\?new=1$/);
  const recipeName = page.getByRole('textbox', { name: 'Recipe Name' });
  await recipeName.fill('Release Test Bowl');
  await expect(recipeName).toHaveValue('Release Test Bowl');
  await page.getByRole('button', { name: 'Save Recipe' }).click();
  await expect(page.getByRole('status')).toContainText('Add at least one ingredient');

  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await page.getByRole('searchbox', { name: 'Search for a food to add as ingredient' }).fill('egg');
  await page.getByRole('button', { name: /Egg, large, 70 calories/i }).click();
  await page.getByRole('dialog', { name: 'Egg, large' }).getByRole('button', { name: 'Add Ingredient' }).click();
  await expect(page.getByRole('region', { name: 'Per-serving nutrition' })).toContainText('70');
  await page.getByRole('spinbutton', { name: 'Number of servings this recipe yields' }).fill('2');
  await page.getByRole('button', { name: 'Save Recipe' }).click();
  const yieldInput = page.getByRole('spinbutton', { name: 'Number of servings this recipe yields' });
  await yieldInput.fill('4');
  await yieldInput.press('Tab');
  await expect(page.getByRole('region', { name: 'Per-serving nutrition' })).toContainText('18');
  await page.getByRole('button', { name: 'Log as Meal' }).click();
  const logDialog = page.getByRole('dialog', { name: 'Log "Release Test Bowl"' });
  await expect(logDialog.locator('.preview-stat').filter({ hasText: 'Calories' })).toContainText('18 kcal');
  await logDialog.getByRole('button', { name: 'Log Meal' }).evaluate(button => {
    button.click();
    button.click();
  });

  await expect(page.getByRole('main', { name: 'Diary' })).toContainText('18');
  await expect(page.getByRole('button', { name: /Egg, large, 0.25 large, 18 calories/i })).toBeVisible();
});

test('a rapid repeated Add Ingredient action adds the ingredient only once', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/recipes', { waitUntil: 'commit' });
  await page.getByRole('button', { name: 'Create new recipe' }).click();
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await page.getByRole('searchbox', { name: 'Search for a food to add as ingredient' }).fill('egg');
  await page.getByRole('button', { name: /Egg, large, 70 calories/i }).click();

  const dialog = page.getByRole('dialog', { name: 'Egg, large' });
  const addButton = dialog.getByRole('button', { name: 'Add Ingredient' });
  await addButton.evaluate(button => {
    button.click();
    button.click();
  });

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('list', { name: 'Ingredient list' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Per-serving nutrition' }))
    .toContainText('70');
});

test('credential-free backup restores into a clean browser profile', async ({ page, browser }, testInfo) => {
  const { targetDate } = await logEggOnPreviousDay(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });
  await page.getByRole('combobox', { name: 'AI provider' }).selectOption('openai');
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('test-secret-that-must-not-export');
  await page.getByRole('checkbox', { name: 'I understand this remote data use.' }).first().check();
  await page.getByRole('button', { name: 'Save AI Settings' }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Data (JSON)' }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath('librelog-backup.json');
  await download.saveAs(backupPath);

  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backup.secretsExcluded).toBe(true);
  expect(JSON.stringify(backup)).not.toContain('test-secret-that-must-not-export');
  expect(backup.stores.meals).toHaveLength(1);

  const cleanContext = await browser.newContext({ serviceWorkers: 'block' });
  const cleanPage = await cleanContext.newPage();
  await preparePage(cleanPage);
  await cleanPage.goto('/#/settings', { waitUntil: 'commit' });
  const chooserPromise = cleanPage.waitForEvent('filechooser');
  await cleanPage.getByRole('button', { name: 'Import Data' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(backupPath);
  const reviewDialog = cleanPage.getByRole('dialog', { name: 'Review Import' });
  await expect(reviewDialog).toContainText('Merge (recommended)');
  await reviewDialog.getByRole('button', { name: 'Merge (Recommended)' }).click();
  await expect(cleanPage.getByRole('status')).toContainText('Import merged');

  await cleanPage.goto(`/#/diary?date=${targetDate}`, { waitUntil: 'commit' });
  await expect(cleanPage.getByRole('button', { name: /Egg, large, 1 large, 70 calories/i })).toBeVisible();
  await cleanContext.close();
});

test('an encrypted backup requires its passphrase and restores in a clean profile', async ({ page, browser }, testInfo) => {
  const { targetDate } = await logEggOnPreviousDay(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });

  const backupPassphrase = 'release backup passphrase';
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Encrypted Data' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export Encrypted Data' });
  const passphraseInput = exportDialog.getByLabel('Passphrase', { exact: true });
  const confirmationInput = exportDialog.getByLabel('Confirm Passphrase');
  await passphraseInput.fill(backupPassphrase);
  await confirmationInput.fill(backupPassphrase);
  await expect(passphraseInput).toHaveValue(backupPassphrase);
  await expect(confirmationInput).toHaveValue(backupPassphrase);
  await exportDialog.getByRole('button', { name: 'Export Encrypted Data' }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath('librelog-backup.encrypted.json');
  await download.saveAs(backupPath);

  const encrypted = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(encrypted.format).toBe('librelog-encrypted-backup');
  expect(JSON.stringify(encrypted)).not.toContain('Egg, large');

  const cleanContext = await browser.newContext({ serviceWorkers: 'block' });
  const cleanPage = await cleanContext.newPage();
  await preparePage(cleanPage);
  await cleanPage.goto('/#/settings', { waitUntil: 'commit' });
  const chooserPromise = cleanPage.waitForEvent('filechooser');
  await cleanPage.getByRole('button', { name: 'Import Data' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(backupPath);

  const importDialog = cleanPage.getByRole('dialog', { name: 'Unlock Encrypted Backup' });
  await importDialog.getByLabel('Passphrase', { exact: true }).fill(backupPassphrase);
  await importDialog.getByRole('button', { name: 'Unlock and Review' }).click();
  const reviewDialog = cleanPage.getByRole('dialog', { name: 'Review Import' });
  await reviewDialog.getByRole('button', { name: 'Full Replacement' }).click();
  await expect(cleanPage.getByRole('status')).toContainText('Import replaced');

  await cleanPage.goto(`/#/diary?date=${targetDate}`, { waitUntil: 'commit' });
  await expect(cleanPage.getByRole('button', { name: /Egg, large, 1 large, 70 calories/i })).toBeVisible();
  await cleanContext.close();
});

test('a favorite usual serving can be found and logged again from meal history', async ({ page }) => {
  await preparePage(page);
  await page.getByRole('button', { name: 'Add food to Lunch' }).click();
  await page.getByRole('searchbox', { name: 'Search for foods' }).fill('egg');
  await page.getByRole('button', { name: /Egg, large.*70 calories per/i }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Egg, large' });
  await dialog.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await dialog.getByRole('spinbutton', { name: 'Quantity' }).press('Tab');
  await dialog.getByRole('checkbox', { name: 'Add this food to Favorites' }).check();
  await dialog.getByRole('checkbox', { name: 'Save this quantity and unit as my usual serving' }).check();
  await dialog.getByRole('button', { name: 'Add to draft' }).click();
  await page.getByRole('button', { name: 'Review meal' }).click();
  await page.getByRole('dialog', { name: /Review lunch/i }).getByRole('button', { name: 'Save meal' }).click();

  await page.getByRole('button', { name: 'Search meal history' }).click();
  await expect(page.getByRole('main', { name: 'Meal History' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search History' }).fill('egg');
  await expect(page.getByRole('listitem')).toContainText('Egg, large');
  await page.getByRole('button', { name: 'Review & Log Again' }).click();
  const reviewDialog = page.getByRole('dialog', { name: 'Review Meal' });
  await expect(reviewDialog).toContainText('Egg, large');
  await reviewDialog.getByRole('button', { name: 'Log Meal' }).evaluate(button => {
    button.click();
    button.click();
  });
  await expect(page.getByRole('status').filter({ hasText: 'Meal logged' })).toBeVisible();

  await page.goto('/#/diary', { waitUntil: 'commit' });
  await expect(page.getByRole('button', { name: /Egg, large, 2 large, 140 calories/i })).toHaveCount(2);
});

for (const route of ['diary', 'search', 'history', 'insights', 'weight', 'recipes', 'settings']) {
  test(`${route} has no automatically detectable WCAG A or AA violations`, async ({ page }) => {
    await preparePage(page);
    await page.goto(`/#/${route}`, { waitUntil: 'commit' });
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('main')).toHaveCount(1);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
  });
}

for (const route of ['diary', 'search']) {
  test(`primary mobile ${route} has no automatically detectable WCAG A or AA violations`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await preparePage(page);
    await page.goto(`/#/${route}`, { waitUntil: 'commit' });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
  });
}

test('Insights tabs report selection and support arrow keys', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/insights', { waitUntil: 'commit' });
  const week = page.getByRole('tab', { name: 'This Week' });
  await week.click();
  await expect(week).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'week insights' })).toBeVisible();
  await week.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'This Month' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'month insights' })).toBeVisible();
});

test('a slower Insights view cannot overwrite the most recently selected tab', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/insights', { waitUntil: 'commit' });
  const month = page.getByRole('tab', { name: 'This Month' });
  const today = page.getByRole('tab', { name: 'Today' });

  await month.click();
  await today.click();
  await expect(today).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'today insights' })).toContainText('Daily Summary');
  await page.waitForTimeout(200);
  await expect(page.getByRole('tabpanel', { name: 'today insights' })).toContainText('Daily Summary');
});

test('Diary carries its viewed date into Meal History', async ({ page }) => {
  await preparePage(page);
  await page.getByRole('button', { name: 'Previous day' }).click();
  const viewedDate = new URL(page.url()).hash.match(/date=(\d{4}-\d{2}-\d{2})/)?.[1];
  await page.getByRole('button', { name: 'Search meal history' }).click();
  await expect(page).toHaveURL(new RegExp(`#\\/history\\?date=${viewedDate}$`));
  await expect(page.getByLabel('Log Again On')).toHaveValue(viewedDate);
  await expect(page.getByRole('link', { name: 'Back to Diary' })).toHaveAttribute('href', `#/diary?date=${viewedDate}`);
});

test('skip link focuses main content without changing the route', async ({ page }) => {
  await preparePage(page);
  const routeBefore = new URL(page.url()).hash;
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await skipLink.press('Enter');
  await expect(page.getByRole('main', { name: 'Diary' })).toBeFocused();
  expect(new URL(page.url()).hash).toBe(routeBefore);
});

test('route changes close page-owned dialogs and restore the app background', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });
  await page.getByRole('button', { name: 'Export Encrypted Data' }).click();
  await expect(page.getByRole('dialog', { name: 'Export Encrypted Data' })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/diary'; });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('#app').evaluate(app => app.inert)).toBe(false);
});

test('nutrition history shows missing days as gaps and excludes today from averages', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/insights', { waitUntil: 'commit' });
  await page.getByRole('tab', { name: 'This Week' }).click();
  await expect(page.getByText('Missing days are gaps. Today is in progress and excluded from averages; past logged days may still be partial.')).toBeVisible();
  await expect(page.locator('.bar-column.in-progress')).toHaveCount(1);
  await expect(page.locator('.bar-column.missing')).toHaveCount(6);
  await expect(page.getByText('No past logged days').first()).toBeVisible();
});

test('the production PWA shell and manifest remain available offline', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright offline service-worker control is Chromium-only.');

  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4177',
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.goto('/#/diary', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();

  const manifestResponse = await context.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('LibreLog');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await context.setOffline(false);
  await context.close();
});

test('a blocked v2 database upgrade explains how to recover without changing data', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4177',
    serviceWorkers: 'block',
  });
  const oldVersionPage = await context.newPage();
  await oldVersionPage.route('**/hold-v2.html', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>LibreLog v2 connection</title>',
  }));
  await oldVersionPage.goto('/hold-v2.html');
  await oldVersionPage.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('librelog');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    window.__oldLibreLogDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open('librelog', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const foods = db.createObjectStore('foods', { keyPath: 'id' });
        foods.createIndex('name', 'name');
        foods.createIndex('barcode', 'barcode');
        foods.createIndex('source', 'source');
        const meals = db.createObjectStore('meals', { keyPath: 'id' });
        meals.createIndex('date', 'date');
        meals.createIndex('mealType', 'mealType');
        meals.createIndex('idempotencyKey', 'idempotencyKey');
        const recipes = db.createObjectStore('recipes', { keyPath: 'id' });
        recipes.createIndex('name', 'name');
        recipes.createIndex('category', 'category');
        const measurements = db.createObjectStore('measurements', { keyPath: 'id' });
        measurements.createIndex('date', 'date');
        db.createObjectStore('settings', { keyPath: 'key' });
        const apiCache = db.createObjectStore('apiCache', { keyPath: 'id' });
        apiCache.createIndex('source', 'source');
        apiCache.createIndex('query', 'query');
        apiCache.createIndex('expiresAt', 'expiresAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });

  const upgradedPage = await context.newPage();
  await upgradedPage.goto('/#/diary', { waitUntil: 'commit' });
  await expect(upgradedPage.getByRole('heading', { name: 'Local data update paused' })).toBeVisible();
  await expect(upgradedPage.getByText(/close other LibreLog tabs or windows/i)).toBeVisible();

  await oldVersionPage.evaluate(() => window.__oldLibreLogDb.close());
  await upgradedPage.getByRole('button', { name: 'Reload LibreLog' }).click();
  await expect(upgradedPage.getByRole('main', { name: 'Diary' })).toBeVisible();
  await context.close();
});

test('a delayed destructive restore cannot be dismissed or close a newer dialog', async ({ page }) => {
  await preparePage(page);
  const emptyBackup = {
    version: 1,
    dataVersion: 3,
    exportedAt: new Date().toISOString(),
    secretsExcluded: true,
    stores: {
      foods: [],
      meals: [],
      recipes: [],
      measurements: [],
      settings: [],
    },
  };
  await page.route('**/dav/**', async route => {
    if (route.request().method() === 'GET') {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyBackup) });
      return;
    }
    await route.fulfill({ status: 207, body: '' });
  });

  await page.goto('/#/settings', { waitUntil: 'commit' });
  await page.locator('#webdav-url').fill('http://127.0.0.1:4177/dav/');
  await page.locator('#webdav-username').fill('release-test');
  await page.locator('#webdav-password').fill('release-test-password');
  await page.locator('#webdav-privacy-consent').check();
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('status')).toContainText('Connection successful');

  await page.getByRole('button', { name: 'Restore Backup', exact: true }).click();
  const restoreDialog = page.getByRole('dialog', { name: 'Restore WebDAV Backup?' });
  await restoreDialog.getByRole('button', { name: 'Restore Backup' }).click();
  await expect(restoreDialog.getByRole('button', { name: 'Restoring...' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(restoreDialog).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/diary'; });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Export Encrypted Data' }).click();
  const newerDialog = page.getByRole('dialog', { name: 'Export Encrypted Data' });
  await expect(newerDialog).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'WebDAV backup restored' })).toBeVisible();
  await expect(newerDialog).toBeVisible();
});

test('a delayed Clear All stays single-flight and cannot close a newer dialog', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });
  await page.evaluate(async () => {
    window.__clearTestLockHeld = false;
    window.__clearTestRelease = null;
    window.__clearTestLock = navigator.locks.request('librelog:data-lifecycle:v1', async () => {
      window.__clearTestLockHeld = true;
      await new Promise(resolve => { window.__clearTestRelease = resolve; });
    });
    while (!window.__clearTestLockHeld) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });

  await page.getByRole('button', { name: 'Clear All Data' }).click();
  const clearDialog = page.getByRole('dialog', { name: 'Clear All Data?' });
  const clearButton = clearDialog.getByRole('button', { name: 'Delete Everything' });
  await clearButton.evaluate(button => {
    button.click();
    button.click();
  });
  await expect(clearDialog.getByRole('button', { name: 'Deleting...' })).toBeDisabled();
  await expect.poll(() => page.evaluate(async () => {
    const state = await navigator.locks.query();
    return state.pending.filter(lock => lock.name === 'librelog:data-lifecycle:v1').length;
  })).toBe(1);
  await page.keyboard.press('Escape');
  await expect(clearDialog).toBeVisible();

  await page.evaluate(() => { window.location.hash = '#/diary'; });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Export Encrypted Data' }).click();
  const newerDialog = page.getByRole('dialog', { name: 'Export Encrypted Data' });
  await expect(newerDialog).toBeVisible();

  await page.evaluate(() => window.__clearTestRelease());
  await expect(page.getByRole('status').filter({ hasText: 'All data cleared' })).toBeVisible();
  await expect(newerDialog).toBeVisible();
});

test('a failed Clear All resumes automatic backups and preserves current data', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('librelog');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['foods', 'settings'], 'readwrite');
      transaction.objectStore('foods').put({
        id: 'clear-failure-marker',
        name: 'Must survive failed clear',
        servingSize: { quantity: 1, unit: 'serving', aliases: [] },
        nutrients: {
          energy: { kcal: 1 },
          macros: { protein: { g: 0 }, carbs: { g: 0 }, fat: { g: 0 } },
          fiber: { g: 0 },
          sodium: { mg: 0 },
        },
        deleted: false,
      });
      transaction.objectStore('settings').put({ key: 'lastBackupTime', value: 0 });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();

    const originalRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function failFirstBackupRemoval(key) {
      if (key === 'librelog_backups') {
        Storage.prototype.removeItem = originalRemoveItem;
        throw new DOMException('Storage is unavailable', 'SecurityError');
      }
      return originalRemoveItem.call(this, key);
    };
  });

  await page.getByRole('button', { name: 'Clear All Data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear All Data?' });
  await dialog.getByRole('button', { name: 'Delete Everything' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Failed to clear data' })).toBeVisible();

  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('librelog');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (store, key) => new Promise((resolve, reject) => {
      const transaction = database.transaction(store, 'readonly');
      const request = transaction.objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [marker, lastBackup] = await Promise.all([
      read('foods', 'clear-failure-marker'),
      read('settings', 'lastBackupTime'),
    ]);
    database.close();
    return Boolean(marker) && Number(lastBackup?.value || 0) > 0;
  })).toBe(true);
});

test('leaving Diary cancels its pending daily-note save', async ({ page }) => {
  await preparePage(page);
  await page.evaluate(() => {
    const note = document.getElementById('daily-note-input');
    note.value = 'must not outlive the Diary page';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    window.location.hash = '#/settings';
  });
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
  await page.waitForTimeout(650);

  const savedNotes = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('librelog');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const settings = await new Promise((resolve, reject) => {
      const request = database.transaction('settings', 'readonly').objectStore('settings').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return settings.filter(record => record.key.startsWith('note_'));
  });
  expect(savedNotes).toEqual([]);
});

test('zero nutrient goals remain disabled without invalid progress values', async ({ page }) => {
  await preparePage(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });
  for (const id of ['goal-protein', 'goal-carbs', 'goal-fat', 'goal-fiber', 'goal-sodium']) {
    await page.locator(`#${id}`).fill('0');
  }
  await page.getByRole('button', { name: 'Save Goals' }).click();
  await expect(page.getByRole('status')).toContainText('Goals saved');

  await page.reload({ waitUntil: 'commit' });
  for (const id of ['goal-protein', 'goal-carbs', 'goal-fat', 'goal-fiber', 'goal-sodium']) {
    await expect(page.locator(`#${id}`)).toHaveValue('0');
  }

  await page.goto('/#/diary', { waitUntil: 'commit' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await expect(page.locator('.macro-value')).toHaveCount(3);
  for (const value of await page.locator('.macro-value').all()) {
    await expect(value).toContainText('no target');
  }
  await expect(page.locator('.micro-grid')).toContainText('0g · no target');
  await expect(page.locator('.micro-grid')).toContainText('0mg · no target');
  await expect(page.locator('[style*="NaN"], [style*="Infinity"]')).toHaveCount(0);

  await page.goto('/#/insights', { waitUntil: 'commit' });
  await expect(page.getByRole('main', { name: 'Insights' })).toBeVisible();
  await expect(page.locator('.stat-card-protein .stat-unit')).toHaveText('no target');
});

test('the document applies the release content security policy', async ({ page }) => {
  await preparePage(page);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'self'");
  expect(policy).not.toContain('fonts.googleapis.com');
  expect(policy).not.toContain('fonts.gstatic.com');
  await expect(page.locator('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]')).toHaveCount(0);
  expect(await page.locator('meta[name="referrer"]').getAttribute('content')).toBe('no-referrer');
});
