import { resourceHref, spaceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { profileHref } from '../features/profile/route.ts';
import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { axeViolations, formatViolations } from './a11y-axe.ts';
import { member, type PageTargets, pageTargets, signIn } from './perf-targets.ts';

// Accessibility of the built site: axe (WCAG 2.2 A and AA) on every page type
// signed out and signed in, in light on a desktop and dark on a phone, then
// what axe cannot see: keyboard-only use, visible focus, reduced motion and
// reflow at 200% and 400% zoom. `node apps/web/tests/a11y-audit.ts` runs the
// wider axe sweep (both themes at both widths, Manage with a moderation queue)
// against any stack.

const upstream = process.env.REZICS_WEB_E2E_BASE_URL ?? 'http://127.0.0.1:3003';
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };

let targets: PageTargets;
let session: BrowserContextOptions['storageState'];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  targets = await pageTargets();
  const account = member();
  if (!account) return;
  const context = await browser.newContext({ baseURL: upstream });
  await signIn(await context.newPage(), '/en', account);
  session = await context.storageState();
  await context.close();
});

const signedOut = (t: PageTargets) => ({
  home: '/en',
  'home-top': '/en?sort=top',
  discover: '/en/discover',
  search: '/en/search?q=tide',
  'search-start': '/en/search',
  work: localizedPath(resourceHref('/w/', t.work), 'en'),
  contents: localizedPath(`${resourceHref('/w/', t.work)}/contents`, 'en'),
  discussion: localizedPath(`${resourceHref('/w/', t.work)}/discussion`, 'en'),
  versions: localizedPath(`${resourceHref('/w/', t.work)}/versions`, 'en'),
  history: localizedPath(`${resourceHref('/w/', t.work)}/history`, 'en'),
  reader: localizedPath(`${resourceHref('/w/', t.work)}/read/${t.chapter}`, 'en'),
  realm: localizedPath(spaceHref(t.realm, 'community'), 'en'),
  'realm-about': localizedPath(spaceHref(t.realm, 'community', ['about']), 'en'),
  profile: localizedPath(profileHref(t.profile), 'en'),
  'notifications-signed-out': '/en/notifications',
  'not-found': '/en/no-such/page',
  chinese: '/zh-Hans',
});

/** Studio opens on the signed-in writer's desk; its pages hang off that address. */
const desk =
  (then = '') =>
  async (page: Page) => {
    await page.goto('/en/studio');
    return `${new URL(page.url()).pathname}${then}`;
  };

const signedIn = {
  home: '/en',
  notifications: '/en/notifications',
  library: '/en/library',
  settings: '/en/settings',
  studio: desk(),
  'studio-new': desk('/new'),
  manage: '/en/manage',
};

/** axe on each page in light on a desktop and dark on a phone. One context carries the session throughout, so
 * a token refresh on one page is what the next page uses (Account revokes a reused refresh token). */
async function sweep(
  browser: Browser,
  pages: Record<string, string | ((page: Page) => Promise<string>)>,
  storageState?: BrowserContextOptions['storageState'],
) {
  const failures: string[] = [];
  const context = await browser.newContext({ baseURL: upstream, storageState });
  const page = await context.newPage();
  try {
    for (const [name, target] of Object.entries(pages)) {
      for (const [theme, viewport] of [
        ['light', desktop],
        ['dark', phone],
      ] as const) {
        await context.addCookies([{ name: 'rezics_theme', value: theme, url: upstream }]);
        await page.setViewportSize(viewport);
        const path = typeof target === 'string' ? target : await target(page);
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const violations = await axeViolations(page);
        if (violations.length)
          failures.push(
            `${name} (${path}, ${theme}, ${viewport.width}px)\n${formatViolations(violations)}`,
          );
      }
    }
  } finally {
    await context.close();
  }
  return failures;
}

test('every signed-out page type passes axe in light on a desktop and dark on a phone', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const failures = await sweep(browser, signedOut(targets));
  expect(failures, failures.join('\n\n')).toEqual([]);
});

test('signed in, Home, Library, settings, Studio and Manage pass axe', async ({ browser }) => {
  test.setTimeout(240_000);
  test.skip(!session, 'No member to sign in');
  const failures = await sweep(browser, signedIn, session);
  expect(failures, failures.join('\n\n')).toEqual([]);
});

/** Whether the focused element draws a focus indicator: an outline or a ring (box-shadow). */
const focusShown = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return { shown: false, name: 'body' };
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    const ring = style.boxShadow !== 'none';
    const box = element.getBoundingClientRect();
    return {
      shown: (outline || ring) && box.width > 0 && box.height > 0,
      name: `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40)}`,
    };
  });

test('keyboard: the skip link comes first, shows, and moves focus to the page', async ({
  page,
}) => {
  await page.goto('/en');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('keyboard: every stop through the header and navigation shows where focus is', async ({
  page,
}) => {
  await page.goto('/en');
  const missing: string[] = [];
  for (let stop = 0; stop < 16; stop += 1) {
    await page.keyboard.press('Tab');
    const focus = await focusShown(page);
    if (!focus.shown) missing.push(focus.name);
  }
  expect(missing, 'Focused without a visible indicator').toEqual([]);
});

test('keyboard: search suggestions open, are chosen with arrows and Enter, and close with Escape', async ({
  page,
}) => {
  await page.goto('/en/discover');
  const search = page.getByRole('combobox', { name: 'Search works' });
  // `/` is handled once the page has hydrated; press until it lands.
  await expect(async () => {
    await page.locator('#main-content').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('/');
    await expect(search).toBeFocused({ timeout: 1_000 });
  }).toPass();
  // The seeded title is indexed shortly after the seed; ask until a suggestion appears.
  await expect(async () => {
    await search.fill('');
    await search.pressSequentially('Cartog', { delay: 40 });
    await expect(search).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', /.+/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/en\/w\/[0-9a-f-]{36}$/);
});

test('keyboard: the feed filters sheet keeps focus inside, closes with Escape and returns focus', async ({
  page,
}) => {
  await page.goto('/en?sort=new');
  const filters = page
    .getByRole('region', { name: 'Posts' })
    .getByRole('button', { name: 'Filters' });
  const sheet = page.getByRole('dialog', { name: 'Filter your feed' });
  // A press that lands before hydration does nothing, so press until the sheet opens.
  await expect(async () => {
    if (await sheet.isVisible()) return;
    await filters.focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible({ timeout: 1_000 });
  }).toPass();
  for (let stop = 0; stop < 12; stop += 1) {
    await page.keyboard.press('Tab');
    expect(await sheet.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
});

test('keyboard: the reader opens its settings from the keyboard and turns chapters with the arrows', async ({
  page,
}) => {
  await page.goto(
    localizedPath(`${resourceHref('/w/', targets.work)}/read/${targets.chapter}`, 'en'),
  );
  const settings = page.getByRole('button', { name: 'Reading settings' });
  await expect(async () => {
    await settings.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Reading settings' })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Reading settings' })).toBeHidden();
  await expect(settings).toBeFocused();
  const chapter = page.url();
  await page.locator('body').press('ArrowRight');
  await expect(page).not.toHaveURL(chapter);
  await expect(page).toHaveURL(/\/read\/[0-9a-f-]{36}$/);
});

test('reduced motion: the navigation sheet opens without animating', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: upstream,
    viewport: phone,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  try {
    await page.goto('/en');
    const open = page.getByRole('button', { name: 'Open navigation' });
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await expect(async () => {
      await open.click();
      await expect(drawer).toBeVisible({ timeout: 1_000 });
    }).toPass();
    const motion = await drawer.evaluate((element) => {
      const style = getComputedStyle(element);
      const seconds = (value: string) =>
        Math.max(
          ...value
            .split(',')
            .map((part) =>
              part.trim().endsWith('ms')
                ? Number.parseFloat(part) / 1_000
                : Number.parseFloat(part),
            ),
        );
      return {
        animation: seconds(style.animationDuration),
        transition: seconds(style.transitionDuration),
      };
    });
    expect(motion.animation).toBeLessThan(0.01);
    expect(motion.transition).toBeLessThan(0.01);
  } finally {
    await context.close();
  }
});

test('zoom: every page type reflows at 200% and 400% without scrolling sideways', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const overflowing: string[] = [];
  // A 1280 px window at 200% lays out at 640 CSS px, and at 400% at 320 (WCAG 1.4.10).
  for (const width of [640, 320]) {
    const context = await browser.newContext({
      baseURL: upstream,
      viewport: { width, height: 720 },
    });
    const page = await context.newPage();
    try {
      for (const [name, path] of Object.entries(signedOut(targets))) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (wide > 1) overflowing.push(`${name} at ${width}px is ${wide}px too wide`);
      }
    } finally {
      await context.close();
    }
  }
  expect(overflowing).toEqual([]);
});
