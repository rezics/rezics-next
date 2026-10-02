import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

interface Seed {
  work: string;
  title: string;
  description: string;
  first: string;
  current: string;
  merged: string;
  retired: string;
  hidden: string;
  hiddenTitle: string;
}

// A public Work reached by current, renamed, merged and retired slugs, and a private Work.
let seed: Seed;
test.beforeAll(async () => {
  test.setTimeout(150_000);
  const result = spawnSync('bun', ['apps/web/tests/seo-seed.ts'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Search-metadata seed failed: ${result.stderr || result.error?.message || result.status}`,
    );
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
  // Main moves its graph position while it processes the seed's events (409 on reads); wait until it holds still.
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${seed.work.slice(-36)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok
      ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition)
      : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for a minute after the seed');
});

const uuid = (iri: string) => iri.slice(-36);
// Link-preview crawlers get metadata in the blocking head; browsers get it streamed.
const PREVIEW_BOT = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

/** The head a link-preview crawler reads for `path`, and the whole document's text. */
async function crawl(page: Page, path: string) {
  const html = await (
    await page.request.get(path, { headers: { 'user-agent': PREVIEW_BOT } })
  ).text();
  return page.evaluate((source) => {
    const document = new DOMParser().parseFromString(source, 'text/html');
    const all = (selector: string, attribute: string) =>
      [...document.head.querySelectorAll(selector)].map((element) =>
        element.getAttribute(attribute),
      );
    return {
      title: document.title,
      text: source,
      canonical: all('link[rel="canonical"]', 'href'),
      robots: all('meta[name="robots"]', 'content'),
      description: all('meta[name="description"]', 'content'),
      ogUrl: all('meta[property="og:url"]', 'content'),
      ogTitle: all('meta[property="og:title"]', 'content'),
      ja: all('link[rel="alternate"][hreflang="ja"]', 'href'),
    };
  }, html);
}

test('a Work is known by its native address whichever of its slugs reaches it', async ({
  page,
}) => {
  const id = uuid(seed.work);
  await page.goto(localizedPath(resourceHref('/w/', seed.current), 'en'));
  await expect(page.getByRole('heading', { level: 1, name: seed.title })).toBeVisible();
  const origin = new URL(page.url()).origin;
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${origin}${localizedPath(resourceHref('/w/', id), 'en')}`,
  );
  await expect(page.locator('link[rel="alternate"][hreflang="zh-Hant"]')).toHaveAttribute(
    'href',
    `${origin}${localizedPath(resourceHref('/w/', id), 'zh-Hant')}`,
  );

  // Renamed and merged slugs move to the current one; the move is never a second identity.
  for (const slug of [seed.first, seed.merged]) {
    await page.goto(localizedPath(resourceHref('/w/', slug.toUpperCase()), 'en'));
    await expect(page).toHaveURL(localizedPath(resourceHref('/w/', seed.current), 'en'));
    await expect(page.getByRole('heading', { level: 1, name: seed.title })).toBeVisible();
  }
  // A retired slug keeps naming no Work, and is not indexed.
  await page.goto(localizedPath(resourceHref('/w/', seed.retired), 'en'));
  await expect(page.getByRole('heading', { level: 1, name: 'Work not found' })).toBeVisible();
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', 'noindex');
});

test('search metadata keeps the view’s selection and indexes only what anyone may read', async ({
  page,
}) => {
  const id = uuid(seed.work);
  await page.goto('/en/search');
  const origin = new URL(page.url()).origin;
  expect(await crawl(page, localizedPath(resourceHref('/w/', seed.current), 'en'))).toMatchObject({
    title: `${seed.title} · REZICS`,
    canonical: [`${origin}${localizedPath(resourceHref('/w/', id), 'en')}`],
    robots: [],
    description: [seed.description],
    ogUrl: [`${origin}${localizedPath(resourceHref('/w/', id), 'en')}`],
    ogTitle: [seed.title],
    ja: [`${origin}${localizedPath(resourceHref('/w/', id), 'ja')}`],
  });
  // A Realm's view is its own page; tracking parameters are not.
  const realm = randomUUID();
  expect(
    await crawl(
      page,
      localizedPath(`${resourceHref('/w/', id)}?scope=realm&realm=${realm}&utm_source=feed`, 'en'),
    ),
  ).toMatchObject({
    canonical: [
      `${origin}${localizedPath(`${resourceHref('/w/', id)}?scope=realm&realm=${realm}`, 'en')}`,
    ],
    robots: [],
  });
  expect(
    await crawl(page, localizedPath(`${resourceHref('/w/', id)}/versions?language=EN`, 'ja')),
  ).toMatchObject({
    canonical: [
      `${origin}${localizedPath(`${resourceHref('/w/', id)}/versions?language=en`, 'ja')}`,
    ],
    robots: [],
  });
  // Personal views and expiring cursors are not indexed.
  expect(
    (await crawl(page, localizedPath(`${resourceHref('/w/', id)}?scope=mine`, 'en'))).robots,
  ).toEqual(['noindex']);
  expect(
    (await crawl(page, localizedPath(`${resourceHref('/w/', id)}/versions?cursor=stale`, 'en')))
      .robots,
  ).toEqual(['noindex']);

  // VIEW07: a private Work gives an anonymous crawler neither its title nor an index entry.
  const hidden = await crawl(page, localizedPath(resourceHref('/w/', uuid(seed.hidden)), 'en'));
  expect(hidden.text).not.toContain(seed.hiddenTitle);
  expect(hidden).toMatchObject({ robots: ['noindex'], description: [], ogTitle: [] });
});

interface PrivateFixture {
  member: { email: string; password: string };
}

test('VIEW07: a private Work its reader may see keeps its title for them and gives search nothing', async ({
  page,
}) => {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path)
    throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  const { member } = JSON.parse(readFileSync(path, 'utf8')) as PrivateFixture;
  const grant = spawnSync('bun', ['apps/web/tests/grant-read.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, REZICS_QA_WORK: seed.hidden },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (grant.status !== 0 || grant.error)
    throw new Error(`QA Work read grant failed: ${grant.stderr || grant.status}`);
  const address = localizedPath(resourceHref('/w/', uuid(seed.hidden)), 'en');
  await signInAtAccounts(page, address, member);
  await expect(page.getByRole('heading', { level: 1, name: seed.hiddenTitle })).toBeVisible();
  await expect(page).toHaveTitle(`${seed.hiddenTitle} · REZICS`);
  // Streamed metadata lands in the body for browsers.
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', 'noindex');
  await expect(page.locator('meta[name="description"], meta[property^="og:"]')).toHaveCount(0);
});
