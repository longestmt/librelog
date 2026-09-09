import { test, expect } from '@playwright/test';

test('the LibreLog logo keeps its dimensions and complete release asset set', async ({ page }) => {

  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.goto('/#/diary', { waitUntil: 'commit' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();

  const logo = page.locator('.brand-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', '/icon.svg');

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

  const releaseAssets = new Map([
    ['/favicon.png', { width: 32, height: 32, type: 'image/png' }],
    ['/icon-192.png', { width: 192, height: 192, type: 'image/png' }],
    ['/icon-512.png', { width: 512, height: 512, type: 'image/png' }],
    ['/icon.svg', { width: 512, height: 512, type: 'image/svg+xml' }],
  ]);
  for (const [asset, expected] of releaseAssets) {
    const response = await page.request.get(asset);
    expect(response.ok(), `${asset} must load`).toBe(true);
    expect(response.headers()['content-type']).toContain(expected.type);
    expect((await response.body()).byteLength).toBeGreaterThan(100);
    const assetDimensions = await page.evaluate(src => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(`Could not decode ${src}`));
      image.src = src;
    }), asset);
    expect(assetDimensions).toEqual({ width: expected.width, height: expected.height });
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
    maxDiffPixelRatio: 0.02,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'commit' });
  await expect(page.getByRole('main', { name: 'Diary' })).toBeVisible();
  await expect(page).toHaveScreenshot('diary-mobile.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});
