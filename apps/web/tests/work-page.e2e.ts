import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { type BrowserContext, expect, type Page, test, type TestInfo } from '@playwright/test';

interface Seed { work: string; realm: string; title: string; reply: string; chapters: string[]; targets: string[] }

// One public Work with versions, Realm adoption, classification, credits,
// ratings, contents and a reviewed reply, seeded once into this isolated QA stack.
let seed: Seed;
test.beforeAll(() => {
  const result = spawnSync('bun', ['apps/web/tests/work-page-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`Work page seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
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
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = uuid(seed.work);
  const realm = uuid(seed.realm);
  await page.goto(`/w/${id}`);
  await expect(page).toHaveTitle(`${seed.title} · REZICS`);
  await expect(page.getByRole('heading', { level: 1, name: seed.title })).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: /Open Library author OL2162284A/ }))
    .toHaveAttribute('href', 'https://openlibrary.org/authors/OL2162284A');
  await expect(page.getByText('Main Version in English')).toBeVisible();
  await expect(page.getByText('Maren Osei')).toBeVisible();
  await expect(page.getByText('La Cartographe des marées')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('region', { name: 'About this Work' })).toContainText('A surveyor maps a delta');

  const scope = page.getByRole('navigation', { name: 'Scope' });
  await expect(scope.getByRole('link', { name: 'Global' })).toHaveAttribute('aria-current', 'true');
  const ratings = page.getByRole('region', { name: 'Ratings' });
  await expect(ratings).toContainText('How good is this Work overall?');
  await expect(ratings).toContainText('3 ratings');
  await expect(ratings).toContainText('4.67');
  await expect(ratings.getByRole('list', { name: 'Rating distribution' }).getByRole('listitem')).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Classification' }).getByRole('listitem'))
    .toHaveText(['AdventureRelevance: Central']);
  await expect(page.getByRole('region', { name: 'Realm adoption' })).toContainText('Adopted the English version');

  // A Realm scope comes from the URL and re-scopes ratings and classification; nothing falls back to Global.
  await scope.getByRole('link', { name: 'Realm: Tidewater Readers' }).click();
  await expect(page).toHaveURL(`/w/${id}?scope=realm&realm=${realm}`);
  await expect(scope.getByRole('link', { name: 'Realm: Tidewater Readers' })).toHaveAttribute('aria-current', 'true');
  await expect(ratings).toContainText('How well does it fit Tidewater Readers?');
  await expect(ratings).toContainText('2 ratings');
  await expect(ratings.getByRole('list', { name: 'Rating distribution' }).getByRole('listitem')).toHaveCount(10);
  const classification = page.getByRole('region', { name: 'Classification' });
  await expect(classification.getByRole('list', { name: 'Decided in Tidewater Readers' })).toHaveText(['Estuary cycle']);
  await expect(classification.getByRole('list', { name: 'From Global' })).toHaveText([/^Adventure/]);
  await expect(page.getByRole('region', { name: 'Realm adoption' })).toContainText('In scope');

  // Tabs are links that keep the scope; each view has its own URL.
  await page.getByRole('navigation', { name: 'Work sections' }).getByRole('link', { name: 'Versions' }).click();
  await expect(page).toHaveURL(`/w/${id}/versions?scope=realm&realm=${realm}`);
  const versions = page.getByRole('region', { name: 'Versions' });
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  await versions.getByRole('combobox', { name: 'Language' }).fill('JA');
  await versions.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(`/w/${id}/versions?kind=&language=JA`);
  await expect(versions.getByRole('listitem')).toHaveCount(1);
  await expect(versions.getByRole('listitem')).toContainText('Japanese');
  await page.goto(`/w/${id}/versions?kind=release`);
  await expect(page.getByRole('heading', { name: 'No versions match these filters' })).toBeVisible();
  await page.goto(`/w/${id}/versions?language=not a tag`);
  await expect(page.getByRole('alert')).toContainText('This link is no longer valid.');

  // History is the Work's public activity, newest first, filtered by kind.
  const sections = page.getByRole('navigation', { name: 'Work sections' });
  await sections.getByRole('link', { name: 'History' }).click();
  await expect(page).toHaveURL(`/w/${id}/history`);
  const history = page.getByRole('region', { name: 'History' });
  await expect(history.getByRole('listitem').first()).toContainText('Reply placed in a Realm');
  await expect(history).toContainText('Version published');
  await expect(history).toContainText('Metadata revised');
  await history.getByRole('link', { name: 'Replies' }).click();
  await expect(page).toHaveURL(`/w/${id}/history?kind=reply-placement`);
  await expect(history.getByRole('listitem')).toHaveCount(1);

  // Discussion shows reviewed replies from every public Realm, or from the chosen one.
  await sections.getByRole('link', { name: 'Discussion' }).click();
  const discussion = page.getByRole('region', { name: 'Discussion' });
  await expect(discussion.getByRole('article')).toHaveCount(1);
  await expect(discussion.getByRole('article')).toContainText(seed.reply);
  await discussion.getByRole('link', { name: 'In Tidewater Readers' }).click();
  await expect(page).toHaveURL(`/w/${id}/discussion?scope=realm&realm=${realm}`);
  await expect(page.getByRole('navigation', { name: 'Scope' })).toContainText('Showing replies reviewed in Tidewater Readers.');
  await expect(discussion.getByRole('article')).toContainText(seed.reply);

  // Contents lists the chapters; one without a publication is shown, unlinked and unnamed, since Main withholds it.
  await sections.getByRole('link', { name: 'Contents' }).click();
  const contents = page.getByRole('region', { name: 'Contents' });
  await expect(contents.getByRole('listitem')).toHaveText([/^Low Water/, /^The Surveyor’s Chain/,
    /^Unavailable chapterNot available to read yet/]);
  await expect(contents.getByRole('link', { name: /Unavailable chapter/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page).toHaveURL(`/w/${id}/contents`);

  // The reader: exact text, next and previous by link and by arrow key, and settings that persist.
  const [first, second] = seed.chapters.map(uuid);
  await contents.getByRole('link', { name: 'Start reading' }).click();
  await expect(page).toHaveURL(`/w/${id}/read/${first}`);
  const article = page.getByRole('article');
  await expect(article).toContainText('The tide went out at four and took the eastern bank with it.');
  await expect(article).toHaveAttribute('lang', 'en');
  await expect(page.getByTitle('This is the first chapter')).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('link', { name: 'Next chapter' }).click();
  await expect(page).toHaveURL(`/w/${id}/read/${second}`);
  await expect(article).toContainText('She set the chain across the mud');
  // The chapter after it has no publication, so this is the last readable one.
  await expect(page.getByTitle('This is the last chapter')).toHaveAttribute('aria-disabled', 'true');
  await expect(async () => {
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(`/w/${id}/read/${first}`, { timeout: 1_000 });
  }).toPass();
  await expect(async () => {
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(`/w/${id}/read/${second}`, { timeout: 1_000 });
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
  await page.goto(`/w/${id}/read/${randomUUID()}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Chapter not found' })).toBeVisible();
  // Streamed metadata lands in the body for browsers; crawlers get the blocking render with it in the head.
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /noindex/);

  // Mine needs a signed-in person; a signed-out reader is told so, not shown Global.
  await page.goto(`/w/${id}?scope=mine`);
  await expect(ratings.getByRole('link', { name: 'Sign in' }))
    .toHaveAttribute('href', `/sign-in?next=${encodeURIComponent(`/w/${id}?scope=mine`)}`);
  await expect(page.getByRole('region', { name: 'Classification' })).toContainText('Classification isn’t personal');
  await page.goto(`/w/${id}?scope=everyone`);
  await expect(page.getByRole('alert')).toContainText('This scope isn’t available');
  await expect(page.getByRole('region', { name: 'Ratings' })).toHaveCount(0);

  // The root loading boundary streams the shell first, so vinext (like Next) answers a view's notFound()
  // with 200 plus noindex rather than 404; the reader still gets the not-found view.
  for (const ref of [randomUUID(), 'no-such-slug']) {
    await page.goto(`/w/${ref}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Work not found' })).toBeVisible();
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  }

  await shoot(page, context, `/w/${id}`, 'overview-en', info);
  await shoot(page, context, `/w/${id}?scope=realm&realm=${realm}`, 'realm-en', info);
  await page.request.post('/locale/select', { form: { locale: 'zh-CN' } });
  await page.goto(`/w/${id}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('region', { name: '评分' })).toContainText('3 个评分');
  await expect(page.getByRole('navigation', { name: '范围' })).toContainText('显示 REZICS 全体用户的评分和分类。');
  await shoot(page, context, `/w/${id}`, 'overview-zh-CN', info);
  await shoot(page, context, `/w/${id}/versions`, 'versions-zh-CN', info);
  await shoot(page, context, `/w/${id}/contents`, 'contents-zh-CN', info);
  await shoot(page, context, `/w/${id}/discussion`, 'discussion-zh-CN', info);
  await shoot(page, context, `/w/${id}/read/${second}`, 'reader-zh-CN', info);
  await page.request.post('/locale/select', { form: { locale: 'en' } });
  await shoot(page, context, `/w/${id}/read/${first}`, 'reader-en', info);
  await shoot(page, context, `/w/${id}/history`, 'history-en', info);
  expect(errors).toEqual([]);
});

interface PrivateFixture { member: { email: string; password: string } }

/** Grants the QA web fixture's Agent `work.read` on one Work, as Access would for a reader with access. */
function grantRead(work: string) {
  const grant = spawnSync('bun', ['apps/web/tests/grant-read.ts'], { cwd: process.cwd(),
    env: { ...process.env, REZICS_QA_WORK: work }, encoding: 'utf8', timeout: 30_000 });
  if (grant.status !== 0 || grant.error) throw new Error(`QA Work read grant failed: ${grant.stderr || grant.status}`);
}

test('a signed-in reader sees their own rating in Mine and keeps reading progress where Main allows it', async ({ page }) => {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  const { member } = JSON.parse(readFileSync(path, 'utf8')) as PrivateFixture;
  const id = uuid(seed.work);
  const next = `/w/${id}?scope=mine`;
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByRole('textbox', { name: 'Email' }).fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(next);
  const ratings = page.getByRole('region', { name: 'Ratings' });
  await expect(ratings).toContainText('You haven’t rated this Work yet');
  await expect(ratings.getByRole('link', { name: 'See Global' })).toHaveAttribute('href', `/w/${id}`);
  await expect(page.getByRole('navigation', { name: 'Scope' }).getByRole('link', { name: 'Mine' }))
    .toHaveAttribute('aria-current', 'true');

  // Main keeps progress only where the reader holds work.read on the Work and the chapter's target.
  const [first, second] = seed.chapters.map(uuid);
  await page.goto(`/w/${id}/read/${first}`);
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
  await page.goto(`/w/${id}/read/${second}`);
  await expect(page.getByText('Progress isn’t kept for this Work yet.')).toBeVisible();
});
