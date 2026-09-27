import { spawnSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test, type TestInfo } from '@playwright/test';

interface Seed { work: string; realm: string; title: string; reply: string }

// The Work page seed: one public Work that the "Tidewater Readers" Realm adopted
// and classified, with published chapters and a reviewed reply. A Realm without a
// Zone renders with the default layout, from Main's Realm and Zone module reads.
let seed: Seed;
test.beforeAll(async () => {
  test.setTimeout(150_000);
  const result = spawnSync('bun', ['apps/web/tests/work-page-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`Realm seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
  // Browse once Main's position has held still for two seconds, as the Work page journey does.
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/realms/${seed.realm.slice(-36)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok ? JSON.stringify((await response.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for a minute after the seed');
});

const uuid = (iri: string) => iri.slice(-36);
const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** Screenshots at desktop and phone sizes in light and dark, with no horizontal overflow. */
async function shoot(page: Page, context: BrowserContext, path: string, name: string, info: TestInfo) {
  for (const theme of ['light', 'dark'] as const) {
    await context.addCookies([{ name: 'rezics_theme', value: theme, url: page.url() }]);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await overflows(page), `${name} ${theme} ${viewport.width}`).toBe(false);
      await page.screenshot({ path: info.outputPath(`${name}-${theme}-${viewport.width}.png`), fullPage: true });
    }
  }
}

test('a Realm renders as its Zone: modules from Main, Decisions behind every pick, tabs, look and safe mode',
  async ({ page, context }, info) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const realm = uuid(seed.realm);
    const work = uuid(seed.work);

    // An unprefixed address takes the reader's locale; the page carries a per-response nonce policy.
    await page.goto(`/r/${realm}`);
    await expect(page).toHaveURL(`/en/r/${realm}`);
    const response = await page.goto(`/en/r/${realm}`);
    expect(response?.headers()['content-security-policy'])
      .toMatch(/^script-src 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'$/);
    await expect(page).toHaveTitle('Tidewater Readers · REZICS');
    await expect(page.getByRole('heading', { level: 1, name: 'Tidewater Readers' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Community sections' }).getByRole('link', { name: 'Home' }))
      .toHaveAttribute('aria-current', 'page');

    // The hero picks the newest adoption; the Latest shelf and the decision log read Main's module reads.
    await expect(page.getByRole('region', { name: 'Featured' }).getByRole('heading', { level: 2, name: seed.title }))
      .toBeVisible();
    const latest = page.getByRole('region', { name: 'Latest' });
    // With chapters published the shelf has sections; "Newly added" lists adoptions.
    if (await latest.getByRole('tab', { name: 'Newly added' }).count()) {
      await latest.getByRole('tab', { name: 'Newly added' }).click();
    }
    await expect(latest.getByRole('heading', { level: 3, name: seed.title })).toBeVisible();
    await expect(latest.getByRole('link', { name: seed.title, exact: true })).toHaveAttribute('href',
      `/en/w/${work}?scope=realm&realm=${realm}`);
    // Every pick links to the Decision that placed it here.
    await expect(latest.getByRole('link', { name: `Why ${seed.title} is here` }))
      .toHaveAttribute('href', new RegExp(`^/en/r/${realm}/decisions#decision-[0-9a-f-]{36}$`));
    const decisions = page.getByRole('region', { name: 'Recent decisions' });
    await decisions.getByRole('link', { name: `Added ${seed.title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/en/r/${realm}/decisions#decision-[0-9a-f-]{36}$`));
    await expect(page.locator('li[data-linked]')).toContainText(`Added ${seed.title}`);
    await expect(page.locator('li[data-linked]')).toContainText('The decision you followed');
    await expect(page.getByRole('region', { name: 'Decision log' })).toContainText(`Classified ${seed.title}`);

    // Tabs share the frame; the Works tab links each Work in this Realm's scope.
    const sections = page.getByRole('navigation', { name: 'Community sections' });
    await sections.getByRole('link', { name: 'Works' }).click();
    await expect(page).toHaveURL(`/en/r/${realm}/works`);
    await expect(page.getByRole('heading', { level: 2, name: 'Works in Tidewater Readers' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: seed.title })).toBeVisible();
    await sections.getByRole('link', { name: 'Discussions' }).click();
    await page.getByRole('link', { name: `Open discussion: ${seed.title}` }).click();
    await expect(page).toHaveURL(`/en/w/${work}/discussion?scope=realm&realm=${realm}`);
    await expect(page.getByRole('region', { name: 'Discussion' }).getByRole('article')).toContainText(seed.reply);
    await page.goto(`/en/r/${realm}/about`);
    await expect(page.getByRole('heading', { level: 2, name: 'About Tidewater Readers' })).toBeVisible();

    // The reader's standard look is a cookie the server honors; scripts hydrate under the nonce policy.
    await page.goto(`/en/r/${realm}`);
    const scope = page.locator('.zone-scope');
    await expect.poll(() => scope.evaluate(element => (element as HTMLElement).style.getPropertyValue('--primary')))
      .toMatch(/^light-dark\(/);
    await page.getByRole('button', { name: 'Page style' }).click();
    await page.getByRole('menuitemradio', { name: 'Standard look' }).click();
    await expect.poll(() => scope.evaluate(element => (element as HTMLElement).style.getPropertyValue('--primary')))
      .toBe('');
    expect((await context.cookies()).find(cookie => cookie.name === 'rezics_zone_look')?.value).toBe('standard');
    await context.clearCookies({ name: 'rezics_zone_look' });

    // Safe mode says why the design is off and how to get it back.
    await page.goto(`/en/r/${realm}?safe`);
    await expect(page.getByText('Showing this community’s standard layout')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Show the full design' })).toHaveAttribute('href', `/en/r/${realm}`);

    // The shell follows the page's locale; an unknown Realm says so.
    await page.goto(`/zh-Hans/r/${realm}`);
    await expect(page.getByRole('navigation', { name: '社区版块' }).getByRole('link', { name: '作品' })).toBeVisible();
    // As on the Work page, the streamed shell means a view's notFound() answers 200 with noindex.
    await page.goto('/en/r/no-such-zone');
    await expect(page.getByRole('heading', { level: 1, name: 'This community isn’t here' })).toBeVisible();
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', 'noindex');

    await shoot(page, context, `/en/r/${realm}`, 'realm-home', info);
    await shoot(page, context, `/zh-Hans/r/${realm}`, 'realm-home-zh', info);
    await shoot(page, context, `/en/r/${realm}/works`, 'realm-works', info);
    await shoot(page, context, `/en/r/${realm}/decisions`, 'realm-decisions', info);
    expect(errors).toEqual([]);
  });
