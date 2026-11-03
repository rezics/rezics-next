import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { HomeFeed } from '../src/features/pages/home-feed';
import { ContentItem } from '@rezics/ui/content-item';
import { homeFeedItemPresentation } from '../src/features/feed/home-feed-item';
import { homeFeedDestination, homeFeedResume } from '../src/features/pages/home-feed-destination';
import type { FeedItem } from '../src/features/pages/home-feed-read';
import { preparedFeedCardReading } from '../src/kernel/fake/feed-card-reading';
import { feedCardTime } from '../src/features/feed/card-attribution';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
function render(items: FeedItem[], locale = 'en') {
  const window = new Window({ url: `https://rezics.example/${locale}` });
  window.document.body.innerHTML = renderToStaticMarkup(
    <ol>
      {items.map((item) => {
        const props = homeFeedItemPresentation(item, locale);
        return (
          <ContentItem
            key={item.id}
            {...props}
            actions={
              <>
                {props.actions}
                <button type="button">Prepared action</button>
              </>
            }
          />
        );
      })}
    </ol>,
  );
  return window;
}

test('each mixed-feed kind preserves source, occurrence, identity, preview and exact localized destination', () => {
  const items = preparedFeedCardReading();
  for (const locale of locales) {
    const window = render(items, locale);
    const rows = [...window.document.querySelectorAll('ol > li')];
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.getAttribute('data-feed-source'))).toEqual(items.map((item) => item.source));
    expect(rows.map((row) => row.querySelector('[data-feed-card-kind]')?.getAttribute('data-feed-card-kind'))).toEqual([
      'work',
      'discussion',
      'reply',
      'review',
      'collection',
      'account',
      'space',
      'work',
    ]);
    for (const [index, item] of items.entries()) {
      const row = rows[index]!;
      expect(row.querySelectorAll('h2')).toHaveLength(1);
      const primary = row.querySelector('a[data-slot="list-row-link"]') ?? row.querySelector('a');
      expect(primary?.getAttribute('href')).toBe(homeFeedDestination(item, locale));
      expect(row.querySelector('[data-feed-card-time] time')?.getAttribute('datetime') ?? null).toBe(item.occurredAt);
      expect(row.querySelector('a a, a button, button a')).toBeNull();
    }
    const reply = rows[2]!;
    expect(reply.querySelector('a')?.getAttribute('href')).toContain('?post=prepared-post#post-prepared-post');
    expect(reply.textContent).toContain('Prepared reply');
    const review = rows[3]!;
    expect(review.querySelector('a')?.getAttribute('href')).toContain('/threads/');
    expect(review.querySelector('[data-feed-card-reviewed-subject] a')?.getAttribute('href')).toContain(
      `/${locale}/subjects/`,
    );
    expect(rows[6]!.querySelector('a')?.getAttribute('href')).toBe(`/${locale}/spaces/prepared-reading-room`);
    expect(rows[6]!.querySelector('[data-feed-card-carrier]')?.textContent).toContain('Prepared carrier Realm');
    expect(rows[6]!.querySelector('[data-feed-card-carrier] a')).toBeNull();
    expect(rows[7]!.querySelector('[data-content-item-slot="actions"] a')?.getAttribute('href')).toBe(
      homeFeedResume(items[7]!, locale),
    );
    expect(rows[7]!.querySelector('[data-content-item-slot="state"]')?.textContent).toBeTruthy();
    expect(rows[5]!.textContent).toContain(m.home_card_automated({}, { locale }));
    const followedWork = render([{ ...items[0]!, source: 'following' } as FeedItem], locale);
    expect(followedWork.document.querySelector('[data-feed-card-source]')?.textContent).toBe(
      m.home_card_source_following({}, { locale }),
    );
    followedWork.happyDOM.abort();
    expect(rows[5]!.querySelector('[data-feed-card-account] a')?.getAttribute('href')).toContain(
      `/${locale}/subjects/`,
    );
    window.happyDOM.abort();
  }
});

test('occurrence and creation stay distinct, null does not borrow creation, and absent metadata is unknown', () => {
  const items = preparedFeedCardReading();
  const discussion = items[1]!;
  const window = render([{ ...discussion, occurredAt: null }]);
  const times = [...window.document.querySelectorAll('[data-feed-card-time]')];
  expect(times[0]!.textContent).toBe('Feed occurrence:Unknown');
  expect(times[0]!.querySelector('time')).toBeNull();
  expect(times[1]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-01T09:00:00.000Z');
  expect(times[1]!.textContent).toContain('Created:');
  expect(feedCardTime('not-a-date', 'en')).toBeNull();
  expect(feedCardTime('', 'en')).toBeNull();
  expect(feedCardTime('2026-11-03T00:00:00Z', 'ja')?.text).toEndWith(' UTC');

  const omitted = structuredClone(discussion);
  if ('author' in omitted.summary) delete omitted.summary.author;
  if ('excerpt' in omitted.summary) delete omitted.summary.excerpt;
  const missing = render([omitted]);
  expect(missing.document.querySelector('[data-feed-card-author]')?.textContent).toContain('Unknown account');
  expect(missing.document.querySelector('[data-feed-card-author] a')).toBeNull();
  expect(missing.document.querySelector('[data-feed-card-preview]')).toBeNull();
  expect(missing.document.body.textContent).not.toContain('Deleted account');
  if ('author' in discussion.summary)
    discussion.summary.author = { displayName: 'Deleted account', handle: null, avatar: null };
  const deleted = render([discussion]);
  expect(deleted.document.querySelector('[data-feed-card-author]')?.textContent).toContain('Deleted account');
  expect(deleted.document.querySelector('[data-feed-card-author] a')).toBeNull();
  const privateData = Object.assign(omitted.summary, {
    privateRules: 'SECRET rule',
    retainedAuthor: 'SECRET reader',
    rating: 5,
  });
  const withheld = render([{ ...omitted, summary: privateData }]);
  expect(withheld.document.body.textContent).not.toContain('SECRET');
  expect(withheld.document.body.textContent).not.toContain('rating');
  for (const page of [window, missing, deleted, withheld]) page.happyDOM.abort();
});

test('missing account and reviewed-Subject targets stay unlinked while native Space keeps its address', () => {
  const items = preparedFeedCardReading();
  const account = items[5]!;
  if ('handle' in account.summary) account.summary.handle = null;
  const space = items[6]!;
  const review = items[3]!;
  if ('subject' in review.summary) delete review.summary.subject;
  const subject = items[0]!;
  if ('creativeWork' in subject.summary) subject.summary.creativeWork = false;
  const window = render([account, space, review, subject]);
  const rows = [...window.document.querySelectorAll('li')];
  expect(homeFeedDestination(account, 'en')).toBeUndefined();
  expect(rows[0]!.querySelector('[data-content-item-slot="visual"] a')).toBeNull();
  expect(rows[0]!.querySelector('a[aria-labelledby]')).toBeNull();
  expect(homeFeedDestination(space, 'en')).toBe('/en/spaces/prepared-reading-room');
  expect(rows[1]!.querySelector('a')?.getAttribute('href')).toBe('/en/spaces/prepared-reading-room');
  expect(rows[2]!.querySelector('[data-feed-card-reviewed-subject]')).toBeNull();
  expect(rows[3]!.querySelector('[data-feed-card-kind]')?.getAttribute('data-feed-card-kind')).toBe('subject');
  expect(window.document.body.textContent).not.toContain('/realms/');
  window.happyDOM.abort();
});

test('1, 10 and 20 rows perform no reads and keep bounded supplied images, title language and image credit', () => {
  const items = preparedFeedCardReading();
  const work = items[0]!;
  if (!('label' in work.summary)) throw new Error('Prepared work summary missing');
  work.summary.label = { value: '長い名前'.repeat(60), language: 'ja' };
  work.summary.cover = {
    media: 'prepared-image',
    width: 320,
    height: 480,
    placeholder: { thumbhash: '', color: '#888888' },
    variants: [
      { format: 'webp', width: 320 },
      { format: 'avif', width: 640 },
    ],
    focalPoint: null,
    credit: {
      rightsHolder: 'Prepared artist',
      via: { name: 'Prepared publisher', url: 'https://example.com/credit' },
      license: 'CC BY 4.0',
      obligations: ['attribution'],
    },
  };
  let reads = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    reads++;
    throw new Error('Card attempted a read');
  }) as unknown as typeof fetch;
  try {
    for (const size of [1, 10, 20]) {
      const rows = Array.from({ length: size }, (_, index) => ({
        ...items[index % items.length]!,
        id: `row:${index}`,
      }));
      const window = render(rows);
      expect(window.document.querySelectorAll('li')).toHaveLength(size);
      expect(window.document.querySelectorAll('img').length).toBeLessThanOrEqual(size * 2);
      expect(window.document.querySelector('h2')?.getAttribute('lang')).toBe('ja');
      expect(window.document.querySelector('[data-feed-card-image-credit]')?.textContent).toContain('Prepared artist');
      expect(window.document.querySelector('[data-feed-card-image-credit] a')?.getAttribute('href')).toBe(
        'https://example.com/credit',
      );
      expect(window.document.querySelector('[data-feed-card-image-credit]')?.textContent).toContain('CC BY 4.0');
      for (const [index, row] of [...window.document.querySelectorAll('li')].entries()) {
        expect(row.querySelector('a')?.getAttribute('href')).toBe(homeFeedDestination(rows[index]!, 'en'));
      }
      expect(reads).toBe(0);
      window.happyDOM.abort();
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
  work.summary.cover.credit.via.url = 'javascript:alert(1)';
  const unsafe = render([work]);
  expect(unsafe.document.querySelector('[data-feed-card-image-credit] a')).toBeNull();
  expect(unsafe.document.body.innerHTML).not.toContain('javascript:');
  work.summary.cover = null;
  const retired = render([work]);
  expect(retired.document.body.innerHTML).not.toContain('prepared-image');
  expect(retired.document.body.textContent).not.toContain('Prepared artist');
  expect(retired.document.querySelector('img')).toBeNull();
  unsafe.happyDOM.abort();
  retired.happyDOM.abort();
});

test('independent primary, cover, author and action keyboard stops survive long names and row retirement at both widths', async () => {
  const window = render(preparedFeedCardReading(true));
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const require = createRequire(import.meta.url);
    const storybook = createRequire(require.resolve('storybook/test'));
    const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
    const user = userEvent.setup({ document: window.document });
    for (const width of [390, 1280]) {
      window.innerWidth = width;
      const rows = [...window.document.querySelectorAll('li')];
      const workLinks = [...rows[0]!.querySelectorAll('a')];
      workLinks[0]!.focus();
      await user.tab();
      expect(window.document.activeElement).toBe(workLinks[1]);
      expect(workLinks[1]!.getAttribute('href')).toBe(workLinks[0]!.getAttribute('href'));
      await user.tab();
      expect(window.document.activeElement).toBe(rows[0]!.querySelector('button'));
      const discussionLinks = [...rows[1]!.querySelectorAll('a')];
      discussionLinks[0]!.focus();
      await user.tab();
      expect(window.document.activeElement).toBe(discussionLinks[1]);
      expect(discussionLinks[1]!.getAttribute('href')).toBe('/en/@prepared_reader');
      await user.tab();
      expect(window.document.activeElement).toBe(rows[1]!.querySelector('button'));
      expect(window.document.querySelector('a a, a button, button a')).toBeNull();
    }
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    try {
      await act(async () =>
        root.render(
          <HomeFeed
            locale="en"
            result={{
              state: 'ready',
              page: {
                feedItems: preparedFeedCardReading(),
                next: null,
                asOf: '2026-11-03T00:00:00Z',
                sources: { discovery: 'ready', following: 'ready', continue: 'ready' },
              },
            }}
          />,
        ),
      );
      expect(host.querySelectorAll('li[data-feed-id]')).toHaveLength(8);
      await act(async () => root.render(<HomeFeed locale="en" result={{ state: 'loading', code: 'loading' }} />));
      expect(host.querySelectorAll('li[data-feed-id], img, a')).toHaveLength(0);
      expect(host.textContent).not.toContain('Prepared reader');
      expect(host.textContent).not.toContain('Prepared carrier Realm');
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.abort();
  }
});
