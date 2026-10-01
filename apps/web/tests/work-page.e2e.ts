import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { type BrowserContext, expect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

interface Seed { work: string; realm: string; title: string; reply: string; chapters: string[]; targets: string[];
  single: { work: string; title: string } }

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
async function shoot(page: Page, context: BrowserContext, path: string, name: string, info: TestInfo, framed = true) {
  for (const theme of ['light', 'dark'] as const) {
    await context.addCookies([{ name: 'rezics_theme', value: theme, url: page.url() }]);
    for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await overflows(page), `${name} ${theme} ${viewport.width}`).toBe(false);
      // Tabs overflow on a phone, so "On this page" takes their place there and only there.
      if (framed) {
        const onThisPage = page.getByRole('button', { name: await page.locator('html').getAttribute('lang') === 'en'
          ? 'On this page' : '本页内容' });
        const tabs = page.getByRole('navigation', { name: /Work sections|作品栏目/ });
        if (viewport.width < 600) { await expect(onThisPage).toBeVisible(); await expect(tabs).toBeHidden(); }
        else { await expect(onThisPage).toBeHidden(); await expect(tabs).toBeVisible(); }
      }
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
  // Main tags a title whose record states no language `und`; the heading carries whatever tag it was given.
  await expect(page.getByRole('heading', { level: 1, name: seed.title })).toHaveAttribute('lang', /^(en|und)$/);
  // A source author opens their REZICS page, named as Open Library lists them or by ID until then.
  await expect(page.locator('a[href="/en/authors/open-library/OL2162284A"]')).toBeVisible();
  await expect(page.getByText(/^Book · English/)).toBeVisible();
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
  // Accepted Concepts open their own page, grouped under the Facet Main names them by.
  await expect(page.getByRole('region', { name: 'Classification' }).getByRole('list', { name: 'Tags' }).getByRole('listitem'))
    .toHaveText(['AdventureRelevance: Central']);
  await expect(page.getByRole('region', { name: 'Classification' }).getByRole('link', { name: 'Adventure' }))
    .toHaveAttribute('href', /^\/en\/concepts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('region', { name: 'Communities' })).toContainText('Reads the English version');
  // The overview follows the documented order, each section under a stable anchor, and omits what the Work's
  // projection does not bind (docs/plan/frontend.md#work-page).
  const hubOrder = ['about', 'availability', 'parts', 'wiki', 'ratings', 'discussion', 'lists'];
  const drawn = await page.locator('[data-hub-section]').evaluateAll(nodes => nodes.map(node => node.id));
  expect(drawn).toEqual(hubOrder.filter(section => drawn.includes(section)));
  expect(drawn).toEqual(expect.arrayContaining(['about', 'ratings', 'discussion', 'lists']));
  // Ratings and reviews come before the lists and discovery that follow them, and details come last.
  const below = async (first: Locator, second: Locator) => (await first.boundingBox())!.y < (await second.boundingBox())!.y;
  expect(await below(page.locator('#ratings'), page.locator('#discussion'))).toBe(true);
  expect(await below(page.locator('#discussion'), page.locator('#lists'))).toBe(true);
  expect(await below(page.locator('#lists'), page.getByText('Details', { exact: true }))).toBe(true);
  // The ratings say what the numbers mean: the question, who answered, the scale and the count.
  await expect(page.locator('[data-rating-basis]')).toContainText('How good is this Work overall?');
  await expect(page.locator('[data-rating-basis]')).toContainText('Rated by: Everyone');
  // Details speak plainly; identifiers wait one step further in, under Cite.
  await expect(page.getByText(seed.work, { exact: true })).toBeHidden();
  await page.getByText('Details', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy citation' })).toBeVisible();
  await expect(page.getByText(seed.work, { exact: true })).toBeHidden();
  await page.getByText('Identifiers', { exact: true }).click();
  await expect(page.getByText(seed.work, { exact: true })).toBeVisible();
  // Reviews answer everyone's rating question; signed out, writing one leads to sign-in.
  const reviews = page.getByRole('region', { name: 'Reviews' });
  await expect(reviews).toContainText('No reviews yet');
  await expect(reviews.getByRole('link', { name: /Write a review/ }))
    .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(`/en/w/${id}`)}`);

  // A community comes from the URL and re-scopes ratings and genres; nothing falls back to everyone's view.
  await scope.getByRole('link', { name: 'Community: Tidewater Readers' }).click();
  await expect(page).toHaveURL(`/en/w/${id}?scope=realm&realm=${realm}`);
  await expect(scope.getByRole('link', { name: 'Community: Tidewater Readers' })).toHaveAttribute('aria-current', 'true');
  await expect(ratings).toContainText('2 ratings');
  await expect(ratings.getByRole('list', { name: 'Rating distribution' }).getByRole('listitem')).toHaveCount(10);
  const classification = page.getByRole('region', { name: 'Classification' });
  await expect(classification).toContainText('Accepted in Tidewater Readers');
  await expect(classification).toContainText('Estuary cycle');
  await expect(classification).toContainText('Accepted by everyone');
  await expect(classification).toContainText('Adventure');
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
  await expect(history.getByRole('listitem').first()).toContainText('A reply was placed in a community');
  await expect(history).toContainText('A version was published');
  await expect(history).toContainText('Details edited');
  await expect(history).not.toContainText('Sequence');
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
  // Read under the cover opens chapter 1 for a reader who has not started, as Contents' Start reading does.
  const [first, second] = seed.chapters.map(uuid);
  await expect(page.getByRole('link', { name: 'Start reading' }).first())
    .toHaveAttribute('href', `/en/w/${id}/read/${first}`);

  // The reader: exact text, next and previous by link and by arrow key, and settings that persist.
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

  // A chapter Work's own address is its place in the Book's reader, never a Work page of its own.
  await page.goto(`/en/w/${uuid(seed.targets[1]!)}`);
  await expect(page).toHaveURL(`/en/w/${id}/read/${second}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The Surveyor’s Chain');

  // A Book with no chapters is read as one text: Start reading opens it, and Contents lists it once.
  const single = uuid(seed.single.work);
  await page.goto(`/en/w/${single}`);
  const startText = page.getByRole('link', { name: 'Start reading' }).first();
  await expect(startText).toHaveAttribute('href', `/en/w/${single}/read`);
  await startText.click();
  await expect(page).toHaveURL(`/en/w/${single}/read`);
  await expect(page.getByRole('heading', { level: 1, name: seed.single.title })).toBeVisible();
  await expect(page.getByRole('article')).toContainText('The tables were right for a hundred years');
  await expect(page.getByRole('navigation', { name: 'Chapters' })).toHaveCount(0);
  await page.goto(`/en/w/${single}/contents`);
  const oneText = page.getByRole('region', { name: 'Contents' });
  await expect(oneText).toContainText('This book is read as one text.');
  await expect(oneText.getByRole('listitem')).toHaveCount(1);
  await expect(oneText).not.toContainText('Main Version');

  await page.goto(`/en/w/${id}/read/${randomUUID()}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Chapter not found' })).toBeVisible();
  // Streamed metadata lands in the body for browsers; crawlers get the blocking render with it in the head.
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /noindex/);

  // Mine needs a signed-in person; a signed-out reader is told so, not shown Global.
  await page.goto(`/en/w/${id}?scope=mine`);
  await expect(ratings.getByRole('link', { name: 'Sign in' }))
    .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(`/en/w/${id}?scope=mine`)}`);
  await expect(page.getByRole('region', { name: 'Classification' })).toContainText('Classification isn’t personal');
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
  await page.getByRole('banner').getByRole('combobox', { name: 'Language' }).click();
  await page.getByRole('option', { name: '简体中文' }).click();
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
  await shoot(page, context, `/zh-Hans/w/${id}/read/${second}`, 'reader-zh-Hans', info, false);
  await page.request.post('/locale/select', { form: { locale: 'en' } });
  await shoot(page, context, `/en/w/${id}/read/${first}`, 'reader-en', info, false);
  await shoot(page, context, `/en/w/${id}/history`, 'history-en', info);
  await shoot(page, context, `/en/w/${single}/read`, 'text-reader-en', info, false);
  expect(errors).toEqual([]);
});

interface PrivateFixture { member: { email: string; password: string } }

test('a signed-in reader shelves and rates a Work, sees their rating in Mine and continues from saved progress', async ({ page }) => {
  test.setTimeout(150_000);
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
  // The QA Person has a baseline membership; missing library controls must fail this journey.
  await page.getByRole('button', { name: 'Want to read', exact: true }).click();
  const shelved = (status: string) => page.getByRole('button', { name: new RegExp(`^${status} — Shelve`) });
  const savedShelf = async (status: string) => {
    await expect(shelved(status)).toBeVisible();
    // The label is optimistic. Wait for Main's acknowledgement before navigating.
    await expect(shelved(status)).not.toHaveAttribute('aria-busy', 'true');
  };
  await savedShelf('Want to read');
  await page.reload();
  await expect(shelved('Want to read')).toBeVisible();
  await shelved('Want to read').click();
  await page.getByRole('menuitemradio', { name: 'Currently reading' }).click();
  await savedShelf('Currently reading');
  await page.reload();
  await expect(shelved('Currently reading')).toBeVisible();
  await shelved('Currently reading').click();
  await page.getByRole('menuitem', { name: 'Remove from my shelves' }).click();
  await expect(page.getByRole('button', { name: 'Want to read', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Want to read', exact: true })).toBeEnabled();

  // The baseline member can read this public Work and its published chapters.
  const [first, second] = seed.chapters.map(uuid);
  await page.goto(`/en/w/${id}/read/${first}`);
  await expect(page.getByText('Progress isn’t kept for this Work yet.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark chapter as read' }).click();
  await expect(page.getByText('Chapter read')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Chapter read')).toBeVisible();
  await page.getByRole('button', { name: 'Mark as unread' }).click();
  await expect(page.getByRole('button', { name: 'Mark chapter as read' })).toBeVisible();
  await page.goto(`/en/w/${id}/read/${second}`);
  await expect(page.getByRole('button', { name: 'Mark chapter as read' })).toBeVisible();

  // Chapter 1 read and the Work on the reader's shelf: Continue opens chapter 2 and names it.
  await page.goto(`/en/w/${id}/read/${first}`);
  await page.getByRole('button', { name: 'Mark chapter as read' }).click();
  await expect(page.getByText('Chapter read')).toBeVisible();
  await page.goto(`/en/w/${id}`);
  await page.getByRole('button', { name: 'Want to read', exact: true }).click();
  await savedShelf('Want to read');
  await shelved('Want to read').click();
  await page.getByRole('menuitemradio', { name: 'Currently reading' }).click();
  await savedShelf('Currently reading');
  await page.reload();
  const resume = page.getByRole('link', { name: 'Continue reading' });
  await expect(resume).toHaveAttribute('href', new RegExp(`^/en/w/${id}/read/${second}(\\?|$)`));
  await expect(page.getByText('The Surveyor’s Chain', { exact: true }).first()).toBeVisible();
  await resume.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The Surveyor’s Chain');

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
