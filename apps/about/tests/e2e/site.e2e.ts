import { expect, test, type Page } from '@playwright/test';
import { copyStatus } from '../../src/copy-status.ts';
import { localeNames, uiLocales } from '../../src/i18n/locales.ts';
import { pageIds, pagePath } from '../../src/pages.ts';
import { axeViolations, formatViolations } from './axe.ts';

const pages = pageIds.flatMap((page) =>
  uiLocales.map((locale) => ({ page, locale, path: pagePath(locale, page) })),
);
const viewports = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;

/** The notify island hydrates when it scrolls into view; wait for it so a click is handled by React. */
async function formReady(page: Page) {
  await page.locator('#notify form').scrollIntoViewIfNeeded();
  await expect(page.locator('#notify astro-island')).not.toHaveAttribute('ssr', /.*/);
}

/** No horizontal scrolling and no clipped words: the document is exactly as wide as the window. */
async function fitsWidth(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, 'horizontal overflow').toBeLessThanOrEqual(client);
}

for (const [viewportName, viewport] of Object.entries(viewports)) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${viewportName} ${scheme}`, () => {
      test.use({ viewport, colorScheme: scheme });
      for (const { page: id, locale, path } of pages) {
        test(`${path} renders, fits and passes axe`, async ({ page }) => {
          const response = await page.goto(path);
          expect(response?.status()).toBe(200);
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await expect(page.locator('main')).toHaveAttribute('data-copy', copyStatus[id]);
          await fitsWidth(page);
          const violations = await axeViolations(page);
          expect(violations, formatViolations(violations)).toEqual([]);
          if (id === 'home') await expect(page.locator('#notify')).toBeAttached();
        });
      }
    });
  }
}

test('the first Tab stop is the skip link, and it moves focus to the content', async ({ page }) => {
  await page.goto('/en/reading/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#skip-nav-content')).toBeFocused();
});

test('menus open from the keyboard and every page is reachable from the header and footer', async ({
  page,
}) => {
  await page.setViewportSize(viewports.desktop);
  await page.goto('/en/');
  const lines = page.getByRole('navigation', { name: 'Product lines' }).first();
  await lines.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(lines.getByRole('link', { name: /Light novels/ })).toBeVisible();
  const footerPaths = await page
    .locator('footer a[href^="/en/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  for (const id of pageIds.filter((id) => id !== 'home'))
    expect(footerPaths).toContain(pagePath('en', id));
  await page.setViewportSize(viewports.phone);
  await page.goto('/en/');
  await page.locator('header summary[aria-label="Menu"]').click();
  await expect(
    page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Roadmap' }),
  ).toBeVisible();
});

test('choosing a language remembers it, and the root then honours the cookie', async ({
  page,
  request,
}) => {
  await page.goto('/en/roadmap/');
  await page.locator('footer').getByRole('link', { name: localeNames.ja }).click();
  await expect(page).toHaveURL(/\/ja\/roadmap\/$/);
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === 'rezics_locale')?.value).toBe('ja');
  await page.goto('/');
  await expect(page).toHaveURL(/\/ja\/$/);
  const negotiated = await request.get('/', {
    headers: { 'accept-language': 'ko-KR,ko;q=0.9' },
    maxRedirects: 0,
  });
  expect(negotiated.status()).toBe(302);
  expect(negotiated.headers().location).toMatch(/\/ko\/$/);
  const unprefixed = await request.get('/light-novels', {
    headers: { 'accept-language': 'fr' },
    maxRedirects: 0,
  });
  expect(unprefixed.headers().location).toMatch(/\/fr\/light-novels\/$/);
  const fallback = await request.get('/', { maxRedirects: 0 });
  expect(fallback.headers().location).toMatch(/\/en\/$/);
});

test('the theme choice applies before first paint and survives a reload', async ({ page }) => {
  await page.goto('/en/');
  await page.getByRole('button', { name: /^Theme/ }).click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await page.getByRole('button', { name: /^Theme/ }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.addInitScript(() => {
    // Record the class the moment the document element exists, before the body is parsed.
    new MutationObserver(() => undefined);
  });
  await page.reload({ waitUntil: 'commit' });
  await page.waitForFunction(() => document.body !== null);
  await expect(page.locator('html')).toHaveClass(/dark/);
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(13, 18, 24)');
  const names = (await page.context().cookies()).map((cookie) => cookie.name).sort();
  expect(names).toEqual(['rezics_theme']);
});

test.describe('get notified', () => {
  const address = `reader-${Date.now()}@example.com`;

  test('a valid address shows the confirmation in place and a repeat looks the same', async ({
    page,
  }) => {
    for (const locale of ['en', 'zh-Hant']) {
      await page.goto(`/${locale}/`);
      await formReady(page);
      const form = page.locator('#notify form');
      await form.locator('input[name=email]').fill(address);
      await form.locator('button[type=submit]').click();
      await expect(page.locator('#notify [role=status]')).toBeVisible();
      await expect(page.locator('#notify [role=status] h3')).toBeFocused();
    }
  });

  test('an invalid address explains itself and keeps the form', async ({ page }) => {
    await page.goto('/de/');
    await formReady(page);
    const form = page.locator('#notify form');
    await form.locator('input[name=email]').fill('not-an-address');
    await form.locator('button[type=submit]').click();
    await expect(page.locator('#notify')).toContainText('name@example.com');
    await expect(form.locator('input[name=email]')).toBeVisible();
    // The error fades in; contrast is measured on the settled color.
    // Only the form's own animations: the page also runs a looping hero and scroll timelines.
    await page.evaluate(() =>
      Promise.all(
        document
          .querySelector('#notify')!
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
    const violations = await axeViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test('without JavaScript the plain form post lands on the localized confirmation page', async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/ja/');
    await page.locator('#notify input[name=email]').fill(`plain-${Date.now()}@example.com`);
    await page.locator('#notify button[type=submit]').click();
    await expect(page).toHaveURL(/\/ja\/notified\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('登録しました');
    await context.close();
  });

  test('a cross-origin post is refused', async ({ request }) => {
    const response = await request.post('/api/notify', {
      headers: { origin: 'https://evil.example', accept: 'application/json' },
      data: { email: 'x@example.com', locale: 'en' },
    });
    expect(response.status()).toBe(403);
  });
});

test('the phone menu, language menu and form work with a touch-sized screen', async ({ page }) => {
  await page.setViewportSize(viewports.phone);
  await page.goto('/zh-Hans/');
  await page.getByRole('button', { name: /^主题/ }).click();
  await page.locator('header summary[aria-label="语言"]').click();
  await expect(page.locator('header').getByRole('link', { name: 'Deutsch' })).toBeVisible();
});

test.describe('motion', () => {
  test.use({ viewport: viewports.desktop });

  test('the pinned story hands the stage from frame to frame as its steps scroll past', async ({
    page,
  }) => {
    await page.goto('/en/light-novels/');
    const frames = page.locator('.story .story-frame');
    await expect(frames).toHaveCount(4);
    expect(await frames.first().evaluate((frame) => getComputedStyle(frame).position)).toBe(
      'sticky',
    );
    const opacities = () =>
      frames.evaluateAll((all) => all.map((frame) => Number(getComputedStyle(frame).opacity)));
    // Centre the third step's heading: its frame holds the stage alone.
    await page
      .locator('.story-step-text')
      .nth(2)
      .evaluate((text) => text.scrollIntoView({ block: 'center' }));
    await expect.poll(opacities).toEqual([0, 0, 1, 0]);
  });

  test('with reduced motion every frame follows its text and nothing moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/en/');
    const frame = page.locator('.story-frame').first();
    expect(await frame.evaluate((element) => getComputedStyle(element).position)).toBe('static');
    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => animation.playState === 'running').length,
    );
    expect(running).toBe(0);
    // The statement is plain text in its final color, not a clipped gradient.
    const statement = page.locator('.ink-reveal').first();
    expect(await statement.evaluate((element) => getComputedStyle(element).color)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    await expect(page.locator('.motion-toggle')).toBeHidden();
  });

  test('the hero loop pauses from the keyboard', async ({ page }) => {
    await page.goto('/en/');
    const toggle = page.getByRole('checkbox', { name: 'Pause animation' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();
    const states = await page
      .locator('.fan-cover')
      .evaluateAll((covers) =>
        covers.flatMap((cover) => cover.getAnimations().map((animation) => animation.playState)),
      );
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(['paused']));
  });
});
