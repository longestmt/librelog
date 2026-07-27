import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

async function preparePage(page) {
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
  const eggResult = page.getByRole('button', { name: /Egg, large.*70 calories/i }).first();
  await expect(eggResult).toBeVisible();
  await eggResult.click();

  const dialog = page.getByRole('dialog', { name: 'Egg, large' });
  await expect(dialog.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('1');
  await expect(dialog).toContainText('70 kcal');
  await dialog.getByRole('button', { name: 'Log Food' }).click();

  await expect(page).toHaveURL(new RegExp(`#\\/diary\\?date=${targetDate}$`));
  await expect(page.getByRole('main', { name: 'Diary' })).toContainText(historicalLabel);
  await expect(page.getByRole('button', { name: /Egg, large, 1 large, 70 calories/i })).toBeVisible();
  return { targetDate, historicalLabel };
}

test('historical meal can be logged, edited, and deleted without changing its date', async ({ page }) => {
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
});

test('recipe requires an ingredient and logs one serving to the diary', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Save Recipe' }).click();
  await page.getByRole('button', { name: 'Log as Meal' }).click();
  await page.getByRole('dialog', { name: 'Log "Release Test Bowl"' }).getByRole('button', { name: 'Log Meal' }).click();

  await expect(page.getByRole('main', { name: 'Diary' })).toContainText('70');
  await expect(page.getByRole('button', { name: /Egg, large, 1 large, 70 calories/i })).toBeVisible();
});

test('credential-free backup restores into a clean browser profile', async ({ page, browser }, testInfo) => {
  const { targetDate } = await logEggOnPreviousDay(page);
  await page.goto('/#/settings', { waitUntil: 'commit' });
  await page.getByRole('combobox', { name: 'AI provider' }).selectOption('openai');
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('test-secret-that-must-not-export');
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
  await expect(cleanPage.getByRole('status')).toContainText('Data imported successfully');

  await cleanPage.goto(`/#/diary?date=${targetDate}`, { waitUntil: 'commit' });
  await expect(cleanPage.getByRole('button', { name: /Egg, large, 1 large, 70 calories/i })).toBeVisible();
  await cleanContext.close();
});

for (const route of ['diary', 'insights', 'weight', 'recipes', 'settings']) {
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

test('primary mobile diary has no automatically detectable WCAG A or AA violations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preparePage(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
});

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

test('the document applies the release content security policy', async ({ page }) => {
  await preparePage(page);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'self'");
  expect(await page.locator('meta[name="referrer"]').getAttribute('content')).toBe('no-referrer');
});
