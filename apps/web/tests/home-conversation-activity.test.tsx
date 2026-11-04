import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHomeFeedWindow, type FeedInput, type HomeFeedResult } from '../src/features/pages/home-feed-read';
import { homeFeedDestination } from '../src/features/pages/home-feed-destination';
import { homeFeedItemPresentation } from '../src/features/feed/home-feed-item';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';

function card(activity: unknown) {
  const item = homeFeedStoryPage('en', true, 'mixed').feedItems.find((candidate) => candidate.key.owner === 'content')!;
  if (activity === undefined) Reflect.deleteProperty(item.summary, 'conversationActivity');
  else Object.assign(item.summary, { conversationActivity: activity });
  const presentation = homeFeedItemPresentation(item, 'en');
  const metadata = renderToStaticMarkup(<>{presentation.metadata}</>);
  const start = metadata.search(/<(?:p|div) data-slot="conversation-activity"/);
  return { html: start < 0 ? '' : metadata.slice(start), href: homeFeedDestination(item, 'en') };
}

test('Home keeps absent activity distinct from withheld after a current card', () => {
  const current = card({
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: 7 },
    lastActivityAt: '2026-11-04T00:00:00.000Z',
  });
  expect(current.html).toContain('Replies: 7');
  const absent = card(undefined);
  expect(absent.html).not.toContain('data-slot="conversation-activity"');
  expect(absent.href).toEqual(current.href);
  const withheld = card({ state: 'withheld' });
  expect(withheld.html).toContain('Reply activity is unavailable.');
  expect(withheld.html).not.toContain('Replies: 7');
  expect(withheld.html).not.toContain('2026-11-04T00:00:00.000Z');
});

test('Home distinguishes exact zero, lower-bound activity and withheld retry without losing its conversation target', () => {
  const zero = card({ state: 'current', cohort: 'public', count: { kind: 'exact', value: 0 }, lastActivityAt: null });
  expect(zero.html).toContain('Replies: 0');
  expect(zero.html).not.toContain('<time');
  expect(zero.href).toContain('/threads/');

  const lowerBound = card({
    state: 'current',
    cohort: 'public',
    count: { kind: 'lower-bound', value: 10_000 },
    lastActivityAt: '2026-11-04T00:00:00.000Z',
  });
  expect(lowerBound.html).toContain('Replies: 10,000+');
  expect(lowerBound.html).toContain('aria-label="At least 10,000 replies"');
  expect(lowerBound.html).toContain('<time dateTime="2026-11-04T00:00:00.000Z"');

  const withheld = card({ state: 'withheld' });
  expect(withheld.html).toContain('role="status"');
  expect(withheld.html).toContain('Reply activity is unavailable.');
  expect(withheld.html).toContain(`href="${withheld.href}"`);
});

test('Home retries the exact failed frontier and retires late activity after selection replacement', async () => {
  const calls: FeedInput[] = [];
  const initial: HomeFeedResult = { state: 'loading', code: 'loading' };
  const cursor = 'native:/+?=&版';
  const page = homeFeedStoryPage('en', true, 'mixed');
  const selected = page.feedItems.find((candidate) => candidate.key.owner === 'content')!;
  Object.assign(selected.summary, {
    conversationActivity: {
      state: 'current',
      cohort: 'public',
      count: { kind: 'exact', value: 7 },
      lastActivityAt: '2026-11-04T00:00:00.000Z',
    },
  });
  const ready: HomeFeedResult = { state: 'ready', page };
  const retry = createHomeFeedWindow(initial, async (input) => {
    calls.push(input);
    return calls.length === 1 ? { state: 'unavailable', code: 'dependency_unavailable' } : ready;
  });
  await retry.load({ stream: 'home', cursor });
  expect(retry.snapshot().input).toEqual({ stream: 'home', cursor });
  await retry.load(retry.snapshot().input);
  expect(calls).toEqual([{ stream: 'home', cursor }, { stream: 'home', cursor }]);

  let resolve!: (result: HomeFeedResult) => void;
  const window = createHomeFeedWindow(ready, () => new Promise((done) => (resolve = done)));
  const pending = window.load({ stream: 'home', cursor });
  window.retire({ state: 'loading', code: 'loading' }, { stream: 'home', kind: 'schema:Book' });
  expect(window.snapshot()).toMatchObject({
    result: { state: 'loading' },
    input: { stream: 'home', kind: 'schema:Book' },
  });
  resolve(ready);
  await pending;
  expect(window.snapshot()).toMatchObject({
    result: { state: 'loading' },
    input: { stream: 'home', kind: 'schema:Book' },
  });
  expect(JSON.stringify(window.snapshot())).not.toContain('conversationActivity');
});
