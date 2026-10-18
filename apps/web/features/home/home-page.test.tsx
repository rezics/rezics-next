import { expect, test } from 'bun:test';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { memoryFeed, NOW } from '../feed/fixtures.ts';
import { FeedProvider } from '../feed/feed-context.tsx';
import { messages as feed } from '../feed/messages.ts';
import { continueItems, railData } from './fixtures.ts';
import { HomePage, type HomePageProps } from './home-page.tsx';
import { messages as home } from './messages.ts';
import { Rail, type RailData } from './rail.tsx';

const router = { bfcacheId: 'home-page-test', back() {}, forward() {}, refresh() {}, hmrRefresh() {},
  push() {}, replace() {}, prefetch() {} };
const emptyRail: RailData = { trending: { scope: 'global', items: [] }, suggestions: [], moderated: [],
  ranking: railData.ranking };

function renderRail(data: RailData, signedIn = false) {
  return renderToStaticMarkup(<AppRouterContext value={router}>
    <FeedProvider locale="en" messages={feed} now={NOW} signedIn={signedIn}
      actingSubject={signedIn ? 'https://rezics.com/id/reader' : null} signInHref="/auth/start"
      avatarQuery="" tab="all" followedRealms={null} api={memoryFeed()}>
      <Rail data={data} signedIn={signedIn} locale="en" messages={home} />
    </FeedProvider>
  </AppRouterContext>);
}

function render(overrides: Partial<HomePageProps> = {}) {
  return renderToStaticMarkup(<AppRouterContext value={router}>
    <HomePage locale="en" messages={{ home, feed }} now={NOW} signedIn={false} actingSubject={null} avatarQuery=""
      state={{ tab: 'all', filter: null, sort: 'best', window: 'week', languages: [], realms: [] }}
      defaults={{ tab: 'all', sort: 'best' }} newPerson={false} followed={null} continueItems={null}
      official={[]} savedFilters={null} setupHref="/en/welcome" setupLater={false} welcomeDismissed={false}
      signInHref="/auth/start" signUpHref="/auth/start?create=1" api={memoryFeed()}
      posts={<article><h3>A reader’s actual discussion</h3><p>A preview from the community.</p></article>}
      {...overrides} />
  </AppRouterContext>);
}

test('signed-out readers meet content before the optional welcome and registration links', () => {
  const html = render();
  const post = html.indexOf('A reader’s actual discussion');
  expect(post).toBeGreaterThan(0);
  expect(html.indexOf('id="welcome-title"')).toBeGreaterThan(post);
  expect(html.indexOf(home.signUp)).toBeGreaterThan(post);
  expect(render({ welcomeDismissed: true })).not.toContain('id="welcome-title"');
});

test('continuation retains the reader’s real next chapter before the feed and setup guidance', () => {
  const html = render({ signedIn: true, actingSubject: 'https://rezics.com/id/reader', newPerson: true, continueItems });
  const continuation = html.indexOf('id="continue-title"');
  const post = html.indexOf('A reader’s actual discussion');
  expect(continuation).toBeGreaterThan(0);
  expect(continuation).toBeLessThan(post);
  expect(html).toContain(continueItems[0]!.nextUnread.href);
  expect(html.indexOf(home.inviteTitle)).toBeGreaterThan(post);
  expect(html).not.toContain('id="welcome-title"');
  expect(render({ continueItems: [] })).not.toContain('id="continue-title"');
});

test('empty rail content reserves no column or trending placeholder while ranking help stays available', () => {
  const html = renderRail(emptyRail);
  expect(html).not.toContain('data-home-rail-content');
  expect(html).not.toContain(home.trendingGlobal);
  expect(html).not.toContain(home.trendingEmpty);
  expect(html).not.toContain(home.popularRealms);
  expect(html).toContain(home.howHomeWorks);
});

for (const content of ['trending', 'suggestions', 'moderated'] as const) {
  test(`an actual ${content} result admits a rail column and retains its useful destinations`, () => {
    const data = { ...emptyRail, [content]: railData[content] };
    const html = renderRail(data, true);
    expect(html).toContain('data-home-rail-content=""');
    const expected = content === 'trending' ? home.trendingFollowed
      : content === 'suggestions' ? home.realmsToFollow : home.queueTitle;
    expect(html).toContain(expected);
  });
}
