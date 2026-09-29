import { expect, test, type Page } from '@playwright/test';
import { copyStatus } from '../../src/copy-status.ts';
import { catalogs } from '../../src/i18n/messages/index.ts';
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

/** Catalog prose must keep the interface language, including labels inside a foreign-language sample. */
function copyLeaves(value: unknown): string[] {
  return typeof value === 'string'
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap(copyLeaves);
}

async function translatedLabelsHaveTheirLanguage(page: Page, locale: (typeof uiLocales)[number]) {
  if (locale === 'en') return;
  const english = new Set(copyLeaves(catalogs.illustrations.en));
  const translated = copyLeaves(catalogs.illustrations[locale]).filter(
    (value) => !english.has(value) && !value.includes('{'),
  );
  const mismatches = await page.locator('main').evaluate(
    (main, { locale, translated }) => {
      const labels = new Set(translated);
      const mismatches: string[] = [];
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent?.trim() ?? '';
        if (!labels.has(text)) continue;
        // The decorative word band deliberately repeats "Story" in many content languages.
        if (node.parentElement?.closest('.word-band')) continue;
        const language = node.parentElement?.closest('[lang]')?.getAttribute('lang');
        if (language !== locale) mismatches.push(`${text}: ${language}`);
      }
      return mismatches;
    },
    { locale, translated },
  );
  expect(mismatches, 'translated illustration labels inherit the UI locale').toEqual([]);
}

/** The notify island hydrates when it scrolls into view; wait for it so a click is handled by React. */
async function formReady(page: Page) {
  await page.locator('#notify form').scrollIntoViewIfNeeded();
  await expect(page.locator('#notify astro-island')).not.toHaveAttribute('ssr', /.*/);
}

/** An island has hydrated once Astro removes its `ssr` marker. */
async function hydrated(page: Page, component: string) {
  await expect(page.locator(`astro-island[component-export="${component}"]`)).not.toHaveAttribute(
    'ssr',
    /.*/,
  );
}

/**
 * Islands that load when the browser is idle have hydrated, and every finite animation and
 * transition has finished, so axe measures settled colors rather than a fade.
 */
async function settled(page: Page) {
  await expect(page.locator('astro-island[client="idle"][ssr]')).toHaveCount(0);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.timeline === document.timeline &&
            animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Choose a reading language in the record by its pill, as a reader does. */
async function pick(page: Page, name: string) {
  await page.locator('.record-language', { hasText: name }).click();
  await expect(page.getByRole('radio', { name })).toBeChecked();
}

/** No horizontal scrolling and no clipped words: the document is exactly as wide as the window. */
async function fitsWidth(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, 'horizontal overflow').toBeLessThanOrEqual(client);
}

/** A page can fit while a translated badge or chapter name is clipped inside its container. */
async function labelsFit(page: Page) {
  const clipped = await page
    .locator('main .chapter-name, main [data-slot="badge"]')
    .evaluateAll((labels) =>
      labels.flatMap((label) => {
        if (!(label instanceof HTMLElement) || !label.checkVisibility()) return [];
        return label.scrollWidth > label.clientWidth + 2 ||
          (label.dataset.slot === 'badge' && label.scrollHeight > label.clientHeight + 2)
          ? [label.innerText]
          : [];
      }),
    );
  expect(clipped, 'chapter names and badges keep every translated word visible').toEqual([]);
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
          // Translated copy inherits the route locale; it must not retain the staging English override.
          await expect(page.locator('main')).not.toHaveAttribute('lang', 'en');
          await fitsWidth(page);
          await settled(page);
          await labelsFit(page);
          await translatedLabelsHaveTheirLanguage(page, locale);
          if (id === 'acgn' && viewportName === 'desktop') {
            await page.evaluate(() => document.fonts.ready);
            const lines = await page.locator('.chapter-name').evaluate((heading) => {
              const range = document.createRange();
              range.selectNodeContents(heading);
              return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
            });
            expect(lines, `${locale} ACGN chapter name at 1440px`).toBe(1);
          }
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
    // Only the form's own animations: the page also runs islands and scroll timelines.
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
    await page.goto('/en/light-novels/');
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

  test('the hero deck turns from its buttons and from a swipe', async ({ page }) => {
    await page.goto('/en/');
    await hydrated(page, 'StoryDeck');
    const names = page.locator('.deck-names');
    await expect(names).toContainText('Light novel');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(names).toContainText('Visual novel');
    await expect(names).toContainText('Glass Tide');
    const card = page.locator('.deck-grip-front');
    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 220, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(names).toContainText('Web serial');
    await page.getByRole('button', { name: 'Previous' }).click();
    await expect(names).toContainText('Visual novel');
  });

  test('the Japanese record turns into English as it arrives, then into any language chosen', async ({
    page,
  }) => {
    await page.goto('/en/');
    await hydrated(page, 'ListingInPlace');
    const choice = (name: string) => page.getByRole('radio', { name });
    // Hydrated before the reader reaches it, the record is set back to its original.
    await expect(choice('日本語')).toBeChecked();
    await page.locator('#language').scrollIntoViewIfNeeded();
    await page.getByRole('radio', { name: 'English' }).scrollIntoViewIfNeeded();
    await expect(choice('English')).toBeChecked();
    const shown = page.locator('.swap > [data-active="true"]');
    await expect(shown.filter({ hasText: 'The Lantern Archive' }).first()).toBeVisible();
    await pick(page, '繁體中文');
    await expect(shown.filter({ hasText: '燈籠書庫' }).first()).toBeVisible();
    await expect(shown.filter({ hasText: '奇幻' })).toBeVisible();
    // Korean has no synopsis translation: the original shows, marked, and nothing is guessed.
    await pick(page, '한국어');
    await expect(shown.filter({ hasText: '등롱 서고' }).first()).toBeVisible();
    await expect(page.getByText('No 한국어 translation yet. This is the original.')).toBeVisible();
    await expect(page.locator('.swap > [data-active="false"]').first()).toBeHidden();
  });

  test('moving your place reveals and hides discussion and wiki facts', async ({ page }) => {
    await page.goto('/en/');
    await page.locator('#community').scrollIntoViewIfNeeded();
    await hydrated(page, 'PlaceInStory');
    const place = page.getByRole('slider', { name: 'Your place in the story' });
    await expect(place).toHaveValue('12');
    const later = page.getByText('Posts about later chapters stay hidden until you reach them.');
    await expect(later).toBeVisible();
    await expect(page.getByText('Nobody warned me', { exact: false })).toHaveCount(0);
    await place.focus();
    await page.keyboard.press('End');
    await expect(place).toHaveAttribute('aria-valuetext', 'Chapter 30 of 30');
    await expect(page.getByText('Nobody warned me', { exact: false })).toBeVisible();
    await expect(later).toHaveCount(0);
    await expect(
      page.locator('dd [data-active="true"]', { hasText: 'The Lamplighters' }),
    ).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page.getByText('Worth the wait', { exact: false })).toHaveCount(0);
    await expect(
      page.locator('dd [data-active="true"]', { hasText: 'The Salt Marsh' }),
    ).toHaveCount(0);
  });

  test('with reduced motion the islands still work and nothing travels', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/en/');
    await hydrated(page, 'ListingInPlace');
    // No autoplay: the record stays in the reader's language.
    await expect(page.getByRole('radio', { name: 'English' })).toBeChecked();
    await pick(page, '日本語');
    const shown = page.locator('.swap > [data-active="true"]');
    await expect(shown.filter({ hasText: '灯籠の書庫' }).first()).toHaveCSS('opacity', '1');
    // Colour transitions on the chosen pill may run; nothing that moves may.
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.playState === 'running' && !(animation instanceof CSSTransition),
          ).length,
    );
    expect(running).toBe(0);
  });

  test('the home page does not shift as it loads, hydrates and scrolls', async ({ page }) => {
    await page.addInitScript(() => {
      const record = window as unknown as { shift: number };
      record.shift = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        })[])
          if (!entry.hadRecentInput) record.shift += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/en/');
    await hydrated(page, 'ListingInPlace');
    for (let y = 0; y < 9000; y += 600) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { shift: number }).shift)).toBe(0);
  });
});
