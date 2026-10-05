import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

test('signed-in readers see Zone showcase art and Work covers', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const privatePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!privatePath) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must name the reader fixture');
  const zonePath = process.env.MEDIA_VIEWER_ZONE_PATH;
  const workPath = process.env.MEDIA_VIEWER_WORK_PATH;
  if (!zonePath || !workPath) throw new Error(
    'MEDIA_VIEWER_ZONE_PATH and MEDIA_VIEWER_WORK_PATH must name public pages with ordinary image art and a cover',
  );
  const { member } = JSON.parse(readFileSync(privatePath, 'utf8')) as {
    member: { email: string; password: string };
  };
  await page.goto(zonePath);
  const images = page.locator('main img[data-slot="media-image"]');
  await expect.soft(images.first(), 'signed-out reader sees ordinary art').toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('zone-signed-out.png') });

  await signInAtAccounts(page, zonePath, member);
  const response = await page.request.get('/api/media-viewer');
  expect.soft(response.status(), 'OAuth reader preferences are available').toBe(200);
  expect.soft(await response.json()).toMatchObject({ ready: true, signedIn: true });
  for (const [name, path] of [['zone', zonePath], ['work', workPath]] as const) {
    await page.goto(path);
    await expect.soft(images.first(), `${name} ordinary image renders for a signed-in reader`).toBeVisible();
    if (await images.count()) {
      await expect.configure({ soft: true }).poll(() => images.first().evaluate((image: HTMLImageElement) =>
        image.complete && image.naturalWidth > 0), { message: `${name} image bytes load` }).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`${name}-signed-in.png`) });
  }
});
