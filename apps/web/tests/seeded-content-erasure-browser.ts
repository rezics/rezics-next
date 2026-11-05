import { resolve } from 'node:path';
import { chromium } from 'playwright';

/** Browser plugin not available; this browser shares the admitted remote stack's loopback. */
export async function walkSeededAuthorErasure(input: {
  web: string;
  threadId: string;
  password: string;
  review: string;
}) {
  const { web, threadId, password, review } = input;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${web}/auth/sign-in?returnTo=${encodeURIComponent(`/en/threads/${threadId}`)}`);
    await page.getByLabel(/email/i).fill('developer@rezics.test');
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.origin === web && url.pathname.includes(threadId));
    for (const locale of ['en', 'zh-Hant', 'ja']) {
      for (const width of [390, 1440]) {
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: 1000 });
          await page.emulateMedia({ colorScheme });
          await page.goto(`${web}/${locale}/threads/${threadId}`);
          await page.locator('html[data-hydrated]').waitFor();
          await page.screenshot({ path: resolve(review, `${locale}-${width}-${colorScheme}.png`), fullPage: true });
        }
      }
    }
    await page.goto(`${web}/en/threads/${threadId}`);
    await page.getByRole('button', { name: 'Erase my posts in this thread…', exact: true }).click();
    await page.getByRole('checkbox', { name: 'I understand that erasing my posts is permanent.' }).check();
    await page.getByRole('button', { name: 'Permanently erase my posts', exact: true }).click();
    await page.waitForURL(/operations/);
    await page.getByText('The service confirmed that cleanup completed for your posts in this thread.', { exact: true })
      .waitFor({ timeout: 180_000 });
    await page.screenshot({ path: resolve(review, 'completed.png'), fullPage: true });
  } finally {
    await browser.close();
  }
}
