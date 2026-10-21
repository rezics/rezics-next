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
import { DiscussionListContent } from './discussion-content.tsx';
import { realmMessagesFor } from './catalog.ts';
import { realmHref } from './route.ts';

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

test('an empty collection offers its Realm browse route without ordering empty results', () => {
  const sample = rankingContractState({ persona: 'visitor', state: 'empty' });
  if (!('items' in sample.answer)) throw new Error('Expected empty threads');
  for (const sort of ['best', 'new', 'top'] as const) {
    const html = renderToStaticMarkup(<AppRouterContext value={router}>
      <FeedProvider locale="en" messages={messages} now={rankingNow} signedIn={false} actingSubject={null}
        signInHref="/auth/start" avatarQuery="" tab="all" followedRealms={null}>
        <RealmRankingPage page={{ ok: true, data: { ...sample.answer, sort } }} path={path} sort={sort} window="all"
          locale="en" feed={messages} />
      </FeedProvider>
    </AppRouterContext>);
    expect(html).toContain('No discussions yet');
    expect(html).toContain(`href="${realmHref('en', sample.answer.realm, 'works')}"`);
    expect(html).toContain('Browse works');
    expect(html).not.toContain('aria-label="Sort:');
    expect(html).not.toContain('aria-label="Period:');
    expect(html).not.toContain('Create post');
    expect(html).not.toContain('Sign in');
  }
});

test('empty Top periods retain their recovery choices without claiming the whole collection is empty', () => {
  const sample = rankingContractState({ persona: 'visitor', state: 'empty', sort: 'top', window: 'month' });
  if (!('items' in sample.answer)) throw new Error('Expected empty threads');
  const html = renderToStaticMarkup(<AppRouterContext value={router}>
    <FeedProvider locale="en" messages={messages} now={rankingNow} signedIn={false} actingSubject={null}
      signInHref="/auth/start" avatarQuery="" tab="all" followedRealms={null}>
      <RealmRankingPage page={{ ok: true, data: sample.answer }} path={path} sort="top" window="month"
        cursor="past-page" locale="en" feed={messages} />
    </FeedProvider>
  </AppRouterContext>);
  expect(html).toContain('No discussions in this period');
  expect(html).toContain('aria-label="Sort: Top"');
  expect(html).toContain('aria-label="Period: This month"');
  expect(html).toContain(`href="/en${path}/discussions?sort=top&amp;t=all"`);
  expect(html).toContain('Show all time');
  expect(html).not.toContain('Browse works');
  expect(html).not.toContain('past-page');
});

test('an empty board or language view offers all discussions without retaining those filters or cursor', () => {
  const sample = rankingContractState({ persona: 'visitor', state: 'empty' });
  if (!('items' in sample.answer)) throw new Error('Expected empty threads');
  for (const filter of [{ concept: 'board-id' }, { language: 'ja' }]) {
    const html = renderToStaticMarkup(<AppRouterContext value={router}>
      <FeedProvider locale="en" messages={messages} now={rankingNow} signedIn={false} actingSubject={null}
        signInHref="/auth/start" avatarQuery="" tab="all" followedRealms={null}>
        <DiscussionListContent page={{ ok: true, data: sample.answer }} path={path}
          query={{ sort: 'best', window: 'all', cursor: 'past-page', ...filter }} locale="en"
          feed={messages} messages={realmMessagesFor('en')} />
      </FeedProvider>
    </AppRouterContext>);
    expect(html).toContain(`href="/en${path}/discussions"`);
    expect(html).toContain('All discussions');
    expect(html).not.toContain('Browse works');
    expect(html).not.toContain('cursor=');
    expect(html).not.toContain('aria-label="Sort:');
  }
});
