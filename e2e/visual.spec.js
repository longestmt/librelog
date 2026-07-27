import { test, expect } from '@playwright/test';

test('the new LibreLog logo keeps its desktop render and release assets', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The visual reference uses the Chromium renderer.');

  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.goto('/#/diary', { waitUntil: 'commit' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();

  const logo = page.locator('.brand-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveScreenshot('librelog-brand-logo.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });

  const dimensions = await logo.evaluate(element => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    naturalWidth: element.naturalWidth,
    naturalHeight: element.naturalHeight,
  }));
  expect(dimensions).toEqual({
    width: 32,
    height: 32,
    naturalWidth: 512,
    naturalHeight: 512,
  });

  for (const asset of ['/favicon.png', '/icon-192.png', '/icon-512.png', '/icon.svg']) {
    const response = await page.request.get(asset);
    expect(response.ok(), `${asset} must load`).toBe(true);
    expect(Number(response.headers()['content-length'] || 1)).toBeGreaterThan(0);
  }
});
