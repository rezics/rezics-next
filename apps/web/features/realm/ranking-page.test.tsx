import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { catalogs } from '../../i18n/catalogs.ts';
import { uiLocales } from '../../i18n/define.ts';
import { spaceHref } from '../address/path.ts';
import { FeedProvider } from '../feed/feed-context.tsx';
import { messages } from '../feed/messages.ts';
import type { Loaded } from '../feed/types.ts';
import type { ThreadsPage } from '../feed/thread.ts';
import { rankingContractState, rankingNow } from './ranking-contract-states.ts';
import { rankingHref, RealmRankingPage } from './ranking-page.tsx';

const path = spaceHref('ranking-garden', 'community');
const router = { bfcacheId: 'ranking-test', back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch() {} };

test('continuations retain an opaque cursor, sort and period; changing coordinates starts at page one', () => {
  const cursor = 'opaque+/= &:reader';
  const next = new URL(rankingHref(path, 'top', 'month', cursor), 'https://rezics.com');
  expect(next.pathname).toBe(`${path}/discussions`);
  expect(Object.fromEntries(next.searchParams)).toEqual({ sort: 'top', t: 'month', cursor });
  expect(rankingHref(path, 'best', 'month')).toBe(`${path}/discussions`);
  expect(rankingHref(path, 'top', 'week')).toBe(`${path}/discussions?sort=top`);
  expect(rankingHref(path, 'top', 'all')).toBe(`${path}/discussions?sort=top&t=all`);
});

for (const locale of uiLocales) {
  test(`${locale}: the production page preserves author credit, independent Work links and continuation`, async () => {
    const sample = rankingContractState({ persona: 'member', state: 'populated', privateRealm: true, sort: 'top', window: 'month' });
    if (!('items' in sample.answer)) throw new Error('Expected threads');
    const feed = await catalogs.feed[locale]();
    const html = renderToStaticMarkup(<AppRouterContext value={router}><FeedProvider locale={locale} messages={feed} now={rankingNow}
      signedIn actingSubject={sample.request.actingSubject} signInHref="/auth/start" avatarQuery=""
      tab="all" followedRealms={null}>
      <RealmRankingPage page={{ ok: true, data: sample.answer }} path={path} sort="top" window="month" locale={locale} feed={feed} />
    </FeedProvider></AppRouterContext>);
    expect(html).toContain('Original current thread 21');
    expect(html).not.toContain('Original retained thread');
    expect(html).toContain('Ranking garden author');
    expect(html).toContain('Original ranking garden');
    expect(html).toContain('lang="en"');
    expect(html).toContain('cursor=contract%3Amember%3Apage-2');
    expect(html).toContain('sort=top');
    expect(html).toContain('t=month');
    expect(html).not.toContain('261 discussions');
  });
}

test('ordinary missing has no closed-Realm explanation, retained rows or recovery action', () => {
  const html = renderToStaticMarkup(<RealmRankingPage page={{ ok: false, failure: 'missing' }}
    path={path} sort="best" window="all" locale="en" feed={messages} />);
  expect(html).toContain('These discussions aren');
  expect(html).not.toContain('closed');
  expect(html).not.toContain('Original');
  expect(html).not.toContain('<a');
});

test('refused continuations offer a restart that discards the cursor and retains Top period', () => {
  for (const failure of ['invalid', 'moved', 'unavailable', 'offline'] as const) {
    const page: Loaded<ThreadsPage> = { ok: false, failure };
    const html = renderToStaticMarkup(<RealmRankingPage page={page} path={path} sort="top" window="month"
      cursor="refused-cursor" locale="en" feed={messages} />);
    expect(html).toContain('sort=top');
    expect(html).toContain('t=month');
    expect(html).not.toContain('refused-cursor');
    expect(html).not.toContain('No discussions');
    expect(html).not.toContain('role="feed"');
  }
});
