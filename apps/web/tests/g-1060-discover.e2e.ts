import { expect, test } from '@playwright/test';
import { browseMessages } from '../features/discover/browse-messages.ts';

for (const locale of ['en', 'zh-Hant'] as const) {
  for (const viewport of [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ]) {
    test(`G1060: ${locale} ${viewport.width} More supersedes a pending tab request`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      let releaseWorks!: () => void;
      const pendingWorks = new Promise<void>((resolve) => {
        releaseWorks = resolve;
      });
      let heldWorks = 0;
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
          url.pathname === `/${locale}/discover` &&
          url.searchParams.get('tab') === 'works' &&
          (request.resourceType() === 'document' || request.resourceType() === 'fetch')
        ) {
          heldWorks++;
          await pendingWorks;
        }
        await route.fallback();
      });
      try {
        await page.goto(`/${locale}/discover?tab=communities`);
        const t = browseMessages[locale];
        const more = page.getByRole('link', { name: t.more, exact: true });
        const destination = await more.getAttribute('href');
        expect(destination).toBeTruthy();
        const cursor = new URL(destination!, page.url()).searchParams.get('cursor');
        expect(cursor).toBeTruthy();
        await expect
          .poll(() =>
            more.evaluate((node) =>
              Object.keys(node).some((key) => key.startsWith('__reactProps$')),
            ),
          )
          .toBe(true);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const works = page
          .getByRole('navigation', { name: t.type, exact: true })
          .getByRole('link', { name: t.works, exact: true });
        // Keep the keyboard focused on Works while scrolling to the footer.
        // The subsequent mouse click is possible on the old page even though
        // Playwright's locator/evaluate actions wait for a document to commit.
        await works.focus();
        await more.hover();
        const point = await more.boundingBox();
        expect(point).not.toBeNull();
        await page.keyboard.press('Enter');
        await expect.poll(() => heldWorks).toBeGreaterThan(0);
        await page.mouse.click(point!.x + point!.width / 2, point!.y + point!.height / 2);
        // The later user choice must commit without waiting for the old response.
        await expect
          .poll(() => new URL(page.url()).searchParams.get('cursor'), { timeout: 15_000 })
          .toBe(cursor);
        // Wait for the abandoned transport to return too; a late response must
        // never win back the address after the newer continuation commits.
        releaseWorks();
        await expect(page.getByRole('link', { name: t.first, exact: true })).toBeVisible();
        // An abandoned document may fail instead of finishing. Wait for all
        // route handlers (including that response) without an arbitrary sleep.
        await page.unrouteAll({ behavior: 'wait' });
        await expect(page).toHaveURL(
          (url) =>
            url.searchParams.get('tab') === 'communities' &&
            url.searchParams.get('cursor') === cursor,
        );
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await info.attach('continuation', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      } finally {
        releaseWorks();
      }
    });

    test(`G1060: ${locale} ${viewport.width} a newer tab choice supersedes pending More`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      let releaseMore!: () => void;
      const pendingMore = new Promise<void>((resolve) => {
        releaseMore = resolve;
      });
      let heldMore = 0;
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
          url.pathname === `/${locale}/discover` &&
          url.searchParams.has('cursor') &&
          (request.resourceType() === 'document' || request.resourceType() === 'fetch')
        ) {
          heldMore++;
          await pendingMore;
        }
        await route.fallback();
      });
      try {
        await page.goto(`/${locale}/discover?tab=communities`);
        const t = browseMessages[locale];
        const more = page.getByRole('link', { name: t.more, exact: true });
        await expect
          .poll(() =>
            more.evaluate((node) =>
              Object.keys(node).some((key) => key.startsWith('__reactProps$')),
            ),
          )
          .toBe(true);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const works = page
          .getByRole('navigation', { name: t.type, exact: true })
          .getByRole('link', { name: t.works, exact: true });
        await more.focus();
        await works.hover();
        const point = await works.boundingBox();
        expect(point).not.toBeNull();
        await page.keyboard.press('Enter');
        await expect.poll(() => heldMore).toBeGreaterThan(0);
        await page.mouse.click(point!.x + point!.width / 2, point!.y + point!.height / 2);
        await expect
          .poll(() => new URL(page.url()).searchParams.get('tab'), { timeout: 15_000 })
          .toBe('works');
        releaseMore();
        await page.unrouteAll({ behavior: 'wait' });
        await expect(works).toHaveAttribute('aria-current', 'page');
        await expect(page).toHaveURL(
          (url) => url.searchParams.get('tab') === 'works' && !url.searchParams.has('cursor'),
        );
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
      } finally {
        releaseMore();
      }
    });

    test(`G1060: ${locale} ${viewport.width} continuation click straddles hydration`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      let releaseScripts!: () => void;
      const scripts = new Promise<void>((resolve) => {
        releaseScripts = resolve;
      });
      let heldScripts = 0;
      await page.route('**/*', async (route) => {
        if (route.request().resourceType() === 'script') {
          heldScripts++;
          await scripts;
        }
        await route.fallback();
      });
      try {
        await page.goto(`/${locale}/discover?tab=communities`, { waitUntil: 'commit' });
        const t = browseMessages[locale];
        const more = page.getByRole('link', { name: t.more, exact: true });
        const destination = await more.getAttribute('href');
        expect(destination).toBeTruthy();
        await expect.poll(() => heldScripts).toBeGreaterThan(0);
        await more.hover();
        await page.mouse.down();
        releaseScripts();
        await expect
          .poll(() =>
            more.evaluate((node) =>
              Object.keys(node).some((key) => key.startsWith('__reactProps$')),
            ),
          )
          .toBe(true);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        await page.mouse.up();
        await expect(page).toHaveURL(new URL(destination!, page.url()).href);
        const first = page.getByRole('link', { name: t.first, exact: true });
        await expect(first).toBeVisible();
        await first.click();
        await expect(page).toHaveURL(
          (url) => url.searchParams.get('tab') === 'communities' && !url.searchParams.has('cursor'),
        );
        await expect(more).toBeVisible();
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await info.attach('first-page', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      } finally {
        releaseScripts();
      }
    });
  }
}
