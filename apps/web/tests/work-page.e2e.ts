import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { type BrowserContext, expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

interface Seed { work: string; realm: string; title: string; reply: string; chapters: string[]; targets: string[] }

// One public Work with versions, Realm adoption, classification, credits,
// ratings, contents and a reviewed reply, seeded once into this isolated QA stack.
let seed: Seed;
test.beforeAll(async () => {
  test.setTimeout(150_000);
  const result = spawnSync('bun', ['apps/web/tests/work-page-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`Work page seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
  // Main keeps processing the seed's events for a while, moving the graph under every read (409). Browse once
  // its position has held still for two seconds.
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${seed.work.slice(-36)}`;
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
    for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await overflows(page), `${name} ${theme} ${viewport.width}`).toBe(false);
      await page.screenshot({ path: info.outputPath(`${name}-${theme}-${viewport.width}.png`), fullPage: true });
    }
  }
}

test('a public Work page reads by scope and tab, and names missing and invalid states', async ({ page, context }, info) => {
  // One journey through every view, then 48 screenshots (views × themes × sizes × locales).
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = uuid(seed.work);
  const realm = uuid(seed.realm);
  await page.goto(`/en/w/${id}`);
  await expect(page).toHaveTitle(`${seed.title} · REZICS`);
  await expect(page.getByRole('heading', { level: 1, name: seed.title })).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: /Open Library author OL2162284A/ }))
    .toHaveAttribute('href', 'https://openlibrary.org/authors/OL2162284A');
  await expect(page.getByText(/· English$/)).toBeVisible();
  await expect(page.getByText('Maren Osei').first()).toBeVisible();
  await expect(page.getByText('La Cartographe des marées').first()).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('region', { name: 'About this Work' })).toContainText('A surveyor maps a delta');
  // The summary under the title leads to the full ratings.
  await expect(page.getByRole('link', { name: '3 ratings' })).toHaveAttribute('href', '#work-ratings');

  const ratings = page.getByRole('region', { name: 'Ratings' });
  const scope = ratings.getByRole('navigation', { name: 'Community' });
  await expect(scope.getByRole('link', { name: 'Everyone' })).toHaveAttribute('aria-current', 'true');
  await expect(ratings).toContainText('3 ratings');
  await expect(ratings).toContainText('4.67');
  await expect(ratings.getByRole('list', { name: 'Rating distribution' }).getByRole('listitem')).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Genres' }).getByRole('listitem'))
    .toHaveText(['AdventureRelevance: Central']);
  await expect(page.getByRole('region', { name: 'Genres' }).getByRole('link', { name: 'Adventure' }))
    .toHaveAttribute('href', /^\/en\/discover\?term=[0-9a-f-]{36}$/);
  await expect(page.getByRole('region', { name: 'Communities' })).toContainText('Reads the English version');
  // Identifiers are folded into Details until asked for.
  await expect(page.getByText(seed.work, { exact: true })).toBeHidden();
  await page.getByText('Details and identifiers').click();
  await expect(page.getByText(seed.work, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy citation' })).toBeVisible();

  // A community comes from the URL and re-scopes ratings and genres; nothing falls back to everyone's view.
  await scope.getByRole('link', { name: 'Community: Tidewater Readers' }).click();
  await expect(page).toHaveURL(`/en/w/${id}?scope=realm&realm=${realm}`);
  await expect(scope.getByRole('link', { name: 'Community: Tidewater Readers' })).toHaveAttribute('aria-current', 'true');
  await expect(ratings).toContainText('2 ratings');
  await expect(ratings.getByRole('list', { name: 'Rating distribution' }).getByRole('listitem')).toHaveCount(10);
  const classification = page.getByRole('region', { name: 'Genres' });
  await expect(classification.getByRole('list', { name: 'Chosen in Tidewater Readers' })).toHaveText(['Estuary cycle']);
  await expect(classification.getByRole('list', { name: 'Chosen by everyone' })).toHaveText([/^Adventure/]);
  await expect(page.getByRole('region', { name: 'Communities' })).toContainText('Showing');

  // Tabs are links that keep the scope; each view has its own URL.
  await page.getByRole('navigation', { name: 'Work sections' }).getByRole('link', { name: 'Versions' }).click();
  await expect(page).toHaveURL(`/en/w/${id}/versions?scope=realm&realm=${realm}`);
  const versions = page.getByRole('region', { name: 'Versions' });
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  await versions.getByRole('combobox', { name: 'Language' }).fill('JA');
  await versions.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(`/en/w/${id}/versions?kind=&language=JA`);
  await expect(versions.getByRole('listitem')).toHaveCount(1);
  await expect(versions.getByRole('listitem')).toContainText('Japanese');
  await page.goto(`/en/w/${id}/versions?kind=release`);
  await expect(page.getByRole('heading', { name: 'No versions match these filters' })).toBeVisible();
  await page.goto(`/en/w/${id}/versions?language=not a tag`);
  await expect(page.getByRole('alert')).toContainText('This link is no longer valid.');

  // History is the Work's public activity, newest first, filtered by kind.
  const sections = page.getByRole('navigation', { name: 'Work sections' });
  await sections.getByRole('link', { name: 'History' }).click();
  await expect(page).toHaveURL(`/en/w/${id}/history`);
  const history = page.getByRole('region', { name: 'History' });
  await expect(history.getByRole('listitem').first()).toContainText('Reply placed in a community');
  await expect(history).toContainText('Version published');
  await expect(history).toContainText('Metadata revised');
  await history.getByRole('link', { name: 'Replies' }).click();
  await expect(page).toHaveURL(`/en/w/${id}/history?kind=reply-placement`);
  await expect(history.getByRole('listitem')).toHaveCount(1);

  // Discussion shows reviewed replies from every public Realm, or from the chosen one.
  await sections.getByRole('link', { name: 'Discussion' }).click();
  const discussion = page.getByRole('region', { name: 'Discussion' });
  await expect(discussion.getByRole('article')).toHaveCount(1);
  await expect(discussion.getByRole('article')).toContainText(seed.reply);
  await discussion.getByRole('link', { name: 'In Tidewater Readers' }).click();
  await expect(page).toHaveURL(`/en/w/${id}/discussion?scope=realm&realm=${realm}`);
  await expect(page.getByRole('navigation', { name: 'Community' })).toContainText('Showing replies reviewed in Tidewater Readers.');
  await expect(discussion.getByRole('article')).toContainText(seed.reply);

  // Contents lists the chapters; one without a publication is shown, unlinked and unnamed, since Main withholds it.
  await sections.getByRole('link', { name: 'Contents' }).click();
  const contents = page.getByRole('region', { name: 'Contents' });
  await expect(contents.getByRole('listitem')).toHaveText([/^Low Water/, /^The Surveyor’s Chain/,
    /^Unavailable chapterNot available to read yet/]);
  await expect(contents.getByRole('link', { name: /Unavailable chapter/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page).toHaveURL(`/en/w/${id}/contents`);

  // The reader: exact text, next and previous by link and by arrow key, and settings that persist.
  const [first, second] = seed.chapters.map(uuid);
  await contents.getByRole('link', { name: 'Start reading' }).click();
  await expect(page).toHaveURL(`/en/w/${id}/read/${first}`);
  const article = page.getByRole('article');
  await expect(article).toContainText('The tide went out at four and took the eastern bank with it.');
  await expect(article).toHaveAttribute('lang', 'en');
  await expect(page.getByTitle('This is the first chapter')).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('link', { name: 'Next chapter' }).click();
  await expect(page).toHaveURL(`/en/w/${id}/read/${second}`);
  await expect(article).toContainText('She set the chain across the mud');
  // The chapter after it has no publication, so this is the last readable one.
  await expect(page.getByTitle('This is the last chapter')).toHaveAttribute('aria-disabled', 'true');
  await expect(async () => {
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(`/en/w/${id}/read/${first}`, { timeout: 1_000 });
  }).toPass();
  await expect(async () => {
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(`/en/w/${id}/read/${second}`, { timeout: 1_000 });
  }).toPass();
  await page.getByRole('button', { name: 'Reading settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Reading settings' });
  await settings.getByRole('button', { name: 'Larger text' }).click();
  await settings.getByRole('button', { name: 'Sans serif' }).click();
  await page.reload();
  await expect(page.locator('[data-face]')).toHaveAttribute('data-face', 'sans');
  expect(await page.locator('[data-face]').evaluate(element => (element as HTMLElement).style
    .getPropertyValue('--reader-size'))).toBe('19px');
  await expect(page.getByText('Sign in to keep your place')).toBeVisible();
  await page.goto(`/en/w/${id}/read/${randomUUID()}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Chapter not found' })).toBeVisible();
  // Streamed metadata lands in the body for browsers; crawlers get the blocking render with it in the head.
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /noindex/);

  // Mine needs a signed-in person; a signed-out reader is told so, not shown Global.
  await page.goto(`/en/w/${id}?scope=mine`);
  await expect(ratings.getByRole('link', { name: 'Sign in' }))
    .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(`/en/w/${id}?scope=mine`)}`);
  await expect(page.getByRole('region', { name: 'Genres' })).toContainText('Genres aren’t personal');
  await page.goto(`/en/w/${id}?scope=everyone`);
  await expect(page.getByRole('alert')).toContainText('This view isn’t available');
  await expect(page.getByRole('region', { name: 'Ratings' })).toHaveCount(0);

  // The root loading boundary streams the shell first, so vinext (like Next) answers a view's notFound()
  // with 200 plus noindex rather than 404; the reader still gets the not-found view.
  for (const ref of [randomUUID(), 'no-such-slug']) {
    await page.goto(`/en/w/${ref}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Work not found' })).toBeVisible();
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  }

  await shoot(page, context, `/en/w/${id}`, 'overview-en', info);
  await shoot(page, context, `/en/w/${id}?scope=realm&realm=${realm}`, 'realm-en', info);
  await page.getByRole('banner').getByRole('combobox', { name: 'Language' }).selectOption('zh-Hans');
  await expect(page).toHaveURL(`/zh-Hans/w/${id}?scope=realm&realm=${realm}`);
  await page.goto(`/zh-Hans/w/${id}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  const origin = new URL(page.url()).origin;
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${origin}/zh-Hans/w/${id}`);
  await expect(page.locator('link[rel="alternate"][hreflang="en"]'))
    .toHaveAttribute('href', `${origin}/en/w/${id}`);
  await expect(page.getByRole('region', { name: '评分' })).toContainText('3 个评分');
  await expect(page.getByRole('region', { name: '评分' }).getByRole('navigation', { name: '社区' })
    .getByRole('link', { name: '所有人' })).toHaveAttribute('aria-current', 'true');
  await shoot(page, context, `/zh-Hans/w/${id}`, 'overview-zh-Hans', info);
  await shoot(page, context, `/zh-Hans/w/${id}/versions`, 'versions-zh-Hans', info);
  await shoot(page, context, `/zh-Hans/w/${id}/contents`, 'contents-zh-Hans', info);
  await shoot(page, context, `/zh-Hans/w/${id}/discussion`, 'discussion-zh-Hans', info);
  await shoot(page, context, `/zh-Hans/w/${id}/read/${second}`, 'reader-zh-Hans', info);
  await page.request.post('/locale/select', { form: { locale: 'en' } });
  await shoot(page, context, `/en/w/${id}/read/${first}`, 'reader-en', info);
  await shoot(page, context, `/en/w/${id}/history`, 'history-en', info);
  expect(errors).toEqual([]);
});

interface PrivateFixture { member: { email: string; password: string } }

/** Grants the QA web fixture's Agent `work.read` on one Work, as Access would for a reader with access. */
function grantRead(work: string) {
  const grant = spawnSync('bun', ['apps/web/tests/grant-read.ts'], { cwd: process.cwd(),
    env: { ...process.env, REZICS_QA_WORK: work }, encoding: 'utf8', timeout: 30_000 });
  if (grant.status !== 0 || grant.error) throw new Error(`QA Work read grant failed: ${grant.stderr || grant.status}`);
}

test('a signed-in reader shelves and rates a Work, sees their rating in Mine and keeps reading progress where Main allows it', async ({ page }) => {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  const { member } = JSON.parse(readFileSync(path, 'utf8')) as PrivateFixture;
  const id = uuid(seed.work);
  const next = `/en/w/${id}?scope=mine`;
  await signInAtAccounts(page, next, member);
  const ratings = page.getByRole('region', { name: 'Ratings' });
  await expect(ratings).toContainText('You haven’t rated this Work yet');
  await expect(ratings.getByRole('link', { name: 'See everyone' })).toHaveAttribute('href', `/en/w/${id}`);
  await expect(ratings.getByRole('navigation', { name: 'Community' }).getByRole('link', { name: 'You' }))
    .toHaveAttribute('aria-current', 'true');

  // The shelf action under the cover writes Main's reader status and survives a reload; the menu changes and clears it.
  await page.getByRole('button', { name: 'Want to read', exact: true }).click();
  const shelved = (status: string) => page.getByRole('button', { name: new RegExp(`^${status} — Shelve`) });
  await expect(shelved('Want to read')).toBeVisible();
  await page.reload();
  await expect(shelved('Want to read')).toBeVisible();
  await shelved('Want to read').click();
  await page.getByRole('menuitemradio', { name: 'Currently reading' }).click();
  await expect(shelved('Currently reading')).toBeVisible();
  await page.reload();
  await expect(shelved('Currently reading')).toBeVisible();
  await shelved('Currently reading').click();
  await page.getByRole('menuitem', { name: 'Remove from my shelves' }).click();
  await expect(page.getByRole('button', { name: 'Want to read', exact: true })).toBeVisible();

  // Main keeps progress only where the reader holds work.read on the Work and the chapter's target.
  const [first, second] = seed.chapters.map(uuid);
  await page.goto(`/en/w/${id}/read/${first}`);
  await expect(page.getByText('Progress isn’t kept for this Work yet.')).toBeVisible();
  grantRead(seed.work);
  grantRead(seed.targets[0]!);
  await page.reload();
  await page.getByRole('button', { name: 'Mark chapter as read' }).click();
  await expect(page.getByText('Chapter read')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Chapter read')).toBeVisible();
  await page.getByRole('button', { name: 'Mark as unread' }).click();
  await expect(page.getByRole('button', { name: 'Mark chapter as read' })).toBeVisible();
  await page.goto(`/en/w/${id}/read/${second}`);
  await expect(page.getByText('Progress isn’t kept for this Work yet.')).toBeVisible();

  // Last, since it adds to the counts earlier cases assert: the stars write the reader's own rating.
  await page.goto(`/en/w/${id}`);
  await page.getByRole('radio').nth(3).click();
  await expect(page.getByText('Your rating', { exact: true })).toBeVisible();
  await expect(page.getByText('Couldn’t save. Try again.')).toHaveCount(0);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
});
