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

test('the diary keeps its release layout at desktop and mobile widths', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The visual references use the Chromium renderer.');

  await page.addInitScript(() => {
    const fixedTime = new Date('2026-07-27T12:00:00-04:00').valueOf();
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedTime]));
      }

      static now() {
        return fixedTime;
      }
    };
  });
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/diary', { waitUntil: 'commit' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await expect(page).toHaveScreenshot('diary-desktop.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.02,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'commit' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await expect(page).toHaveScreenshot('diary-mobile.png', {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.02,
  });
});
