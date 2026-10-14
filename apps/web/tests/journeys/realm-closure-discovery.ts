import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { catalogs } from '../../i18n/catalogs.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { addressPath, parseAddressSegment, spaceHref } from '../../features/address/path.ts';
import { browseHref, emptyBrowse } from '../../features/discover/browse-state.ts';
import { browseMessages } from '../../features/discover/browse-messages.ts';
import { credentials, signIn } from '../g-743-stack.ts';
import { expectClean, type Findings, keyboardReach, locales, pressByKeyboard } from '../g-743-matrix.ts';
import { realmClosureFixture } from '../realm-closure-discovery-fixture.ts';

type Fixture = Awaited<ReturnType<typeof realmClosureFixture>>;
const originalLink = (page: Page, fixture: Fixture) =>
  page.getByRole('link', { name: fixture.title, exact: true }).first();
const feedPath = (realm?: string) => `/?${new URLSearchParams({ tab: 'all', sort: 'new', ...(realm ? { realm } : {}) })}`;
const rankingPath = (space: string, sort: 'best' | 'top', window: 'week' | 'month' | 'all') =>
  `${spaceHref(space, 'community', ['discussions'])}?${new URLSearchParams({ sort, t: window })}`;
const searchPath = (fixture: Fixture, scoped: boolean) => browseHref({ ...emptyBrowse, q: fixture.phrase,
  scope: scoped ? { kind: 'realm', realm: fixture.realm.slice(-36) } : { kind: 'global' } });

async function visit(page: Page, path: string) {
  // The feed polls in the background; its network quiet is not page readiness.
  // Concurrent Docker startup can change Chromium's network generation even
  // on loopback. Retry only that transport interruption, with the same address.
  await page.goto('about:blank');
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(path, { waitUntil: 'domcontentloaded' }); return; }
    catch (error) {
      if (attempt === 2 || !(error instanceof Error)
        || !/ERR_NETWORK_CHANGED|ERR_ABORTED|interrupted by another navigation to "chrome-error:/.test(error.message)) throw error;
      await page.goto('about:blank');
    }
  }
}

export function registerRealmClosureDiscoveryJourneys(
  surfaces: readonly ('feed' | 'rankings' | 'search')[] = ['feed', 'rankings', 'search'],
) {
  test.use({ actionTimeout: 15_000 });
  for (const surface of surfaces) {
    test(`realm-closure-${surface}: a returning member loses closed Realm results after reload and keeps the original`, async ({ page }, info) => {
      test.setTimeout(360_000);
      await signIn(page, '/en', credentials().member);
      const fixture = await realmClosureFixture(page, info, surface);
      const found: Findings = [];
      const absentHeadings = new Map<string, string>();
      const rankedPath = rankingPath(fixture.space, 'best', 'all');
      const beforePath = surface === 'feed' ? feedPath(fixture.realm)
        : surface === 'rankings' ? rankedPath : searchPath(fixture, true);
      try {
        // Both locales must show the actual populated collection before closure:
        // an empty or failed surface can never qualify an omission afterwards.
        for (const locale of Object.values(locales)) {
          if (surface === 'rankings') {
            await visit(page, localizedPath(rankingPath(randomUUID(), 'best', 'all'), locale));
            absentHeadings.set(locale, await page.getByRole('heading', { level: 1 }).innerText());
          }
          await visit(page, localizedPath(beforePath, locale));
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          if (surface === 'search') await expect(originalLink(page, fixture)).toBeVisible();
          else await expect(page.getByRole('link', { name: fixture.threadTitle, exact: true }).first()).toBeVisible();
          await keyboardReach(page, surface === 'search' ? originalLink(page, fixture)
            : page.getByRole('link', { name: fixture.threadTitle, exact: true }).first(), found, `${surface} result (${locale})`);
          await page.screenshot({ path: info.outputPath(`${surface}-open-${locale}.png`) });
        }

        await test.step('the platform closes the exact Realm through public report, review and decision commands', async () => {
          await fixture.close();
          const path = `/realms/${fixture.realm.slice(-36)}`;
          const closed = await fixture.api.inspect(path);
          const absent = await fixture.api.inspect(`/realms/${randomUUID()}`);
          expect(closed, `GET /v1${path}: ${JSON.stringify(closed)}`).toEqual(absent);
          expect(closed.status).toBe(404);
        });

        for (const locale of Object.values(locales)) {
          const feed = materializeData(await catalogs.feed[locale](), { locale });
          await visit(page, localizedPath(beforePath, locale));
          await page.reload();
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          if (surface === 'rankings') {
            await expect(page.getByRole('heading', { level: 1 })).toHaveText(absentHeadings.get(locale)!);
            // Every ordinary ranking address obeys the same closure rule.
            for (const window of ['week', 'month', 'all'] as const) {
              await visit(page, localizedPath(rankingPath(fixture.space, 'top', window), locale));
              await page.reload();
              await expect(page.getByRole('heading', { level: 1 })).toHaveText(absentHeadings.get(locale)!);
              await expect(page.getByText(fixture.threadTitle, { exact: true })).toHaveCount(0);
            }
          } else if (surface === 'search') {
            const unavailable = page.getByRole('alert').getByText(browseMessages[locale].unavailable, { exact: true });
            // Both the chapter-text stream and the resource list lose their
            // Realm scope. Neither may qualify the other's failure alone.
            await expect(unavailable).toHaveCount(2);
            await expect(unavailable.nth(0)).toBeVisible();
            await expect(unavailable.nth(1)).toBeVisible();
            await expect(originalLink(page, fixture)).toHaveCount(0);
          } else {
            await expect(page.getByRole('heading', { name: feed.emptyFiltered, exact: true })).toBeVisible();
            await expect(page.getByRole('article')).toHaveCount(0);
            // Following and the global feed must not retain a Realm discussion.
            for (const path of ['/?tab=following&sort=new', feedPath()]) {
              await visit(page, localizedPath(path, locale));
              await page.reload();
              if (path === feedPath()) await expect(originalLink(page, fixture)).toBeVisible();
              else await expect(page.getByRole('heading', { name: feed.emptyFollowing, exact: true })).toBeVisible();
              await expect(page.getByRole('link', { name: fixture.threadTitle, exact: true })).toHaveCount(0);
              await expect(page.getByRole('article').filter({ hasText: fixture.realmName })).toHaveCount(0);
            }
          }
          await page.screenshot({ path: info.outputPath(`${surface}-closed-${locale}.png`) });

          // The same Work's independent occurrence is still discoverable and
          // keyboard traversable; closing a community cannot erase its author.
          if (surface !== 'feed') {
            await visit(page, localizedPath(surface === 'search' ? searchPath(fixture, false) : feedPath(), locale));
            await page.reload();
          }
          await expect(originalLink(page, fixture)).toBeVisible();
          const href = await originalLink(page, fixture).getAttribute('href');
          expect(href).toBeTruthy();
          const isOriginal = (url: URL) => {
            const path = addressPath(url.pathname);
            const segment = path && parseAddressSegment(path.lookup.key);
            return path?.lookup.scope === 'work' && path.tail.length === 0
              && segment?.kind !== 'alias' && segment?.id === fixture.work.slice(-36);
          };
          expect(isOriginal(new URL(href!, page.url()))).toBe(true);
          await pressByKeyboard(page, originalLink(page, fixture), found, `independent original (${locale})`);
          await expect(page).toHaveURL(isOriginal, { timeout: 30_000 });
          await page.reload();
          await expect(page.getByRole('heading', { level: 1, name: fixture.title, exact: true })).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          const credits = await fixture.api.read<{ items: { agent: string; role: string }[] }>(
            `/works/${fixture.work.slice(-36)}/agent-credits`);
          expect(credits.items).toContainEqual(expect.objectContaining({ agent: fixture.actor, role: 'author' }));
          await page.screenshot({ path: info.outputPath(`${surface}-original-${locale}.png`) });
        }
        expectClean(found);
      } finally { await fixture.dispose(); }
    });
  }
}
