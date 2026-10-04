import { expect, test } from '@playwright/test';
import { browseMessages } from '../features/discover/browse-messages.ts';

for (const locale of ['en', 'zh-Hant'] as const) {
  for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
    for (const timing of ['scripts held', 'hydrated'] as const) {
      test(`G1057: ${locale} ${viewport.width} ${timing} latest Discover choice supersedes a pending Works request`, async ({ page }, info) => {
        await page.setViewportSize(viewport);
        let releaseScripts!: () => void;
        let releaseWorks!: () => void;
        const scripts = new Promise<void>((resolve) => { releaseScripts = resolve; });
        const worksRequest = new Promise<void>((resolve) => { releaseWorks = resolve; });
        let heldScripts = 0;
        let heldWorks = 0;
        await page.route('**/*', async (route) => {
          const request = route.request();
          if (timing !== 'hydrated' && request.resourceType() === 'script') {
            heldScripts++;
            await scripts;
          }
          const url = new URL(request.url());
          if (url.pathname === `/${locale}/discover` && url.searchParams.get('tab') === 'works' &&
            (request.resourceType() === 'document' || request.resourceType() === 'fetch')) {
            heldWorks++;
            await worksRequest;
          }
          await route.continue();
        });
        try {
          await page.goto(`/${locale}/discover`, { waitUntil: 'commit' });
          const t = browseMessages[locale];
          const tabs = page.getByRole('navigation', { name: t.type, exact: true });
          const works = tabs.getByRole('link', { name: t.works, exact: true });
          const communities = tabs.getByRole('link', { name: t.communities, exact: true });
          await expect(works).toHaveAttribute('href', `/${locale}/discover?tab=works`);
          if (timing === 'hydrated') {
            await expect.poll(() => works.evaluate((node) => Object.keys(node)
              .some((key) => key.startsWith('__reactProps$')))).toBe(true);
            await page.evaluate(() => new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }));
          } else await expect.poll(() => heldScripts).toBeGreaterThan(0);
          const nextChoice = await communities.boundingBox();
          expect(nextChoice).not.toBeNull();
          await works.click({ noWaitAfter: true });
          await expect.poll(() => heldWorks).toBeGreaterThan(0);
          // A locator waits for a pending document navigation before acting, even
          // with noWaitAfter. A person can still press this link on the old page.
          await page.mouse.click(nextChoice!.x + nextChoice!.width / 2, nextChoice!.y + nextChoice!.height / 2);
          // A held hydration script deliberately prevents the load event.
          await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('communities');
          await expect(communities).toHaveAttribute('aria-current', 'page');
          // A late first response must not undo the latest selected tab.
          releaseWorks();
          releaseScripts();
          await expect(communities).toHaveAttribute('aria-current', 'page');
          await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'communities');
          await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
          await page.screenshot({ path: `.temp/g-1057/${locale}-${viewport.width}-${timing.replaceAll(' ', '-')}.png`, fullPage: true });
          await info.attach('latest-tab', { body: await page.screenshot(), contentType: 'image/png' });
        } finally { releaseWorks(); releaseScripts(); }
      });
    }
  }
}
