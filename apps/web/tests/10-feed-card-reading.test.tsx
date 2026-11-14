import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { ContentItem } from '@rezics/ui/content-item';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeedItem, HomeFeedResult } from '../src/features/pages/home-feed-read';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { HomeFeed } = await import('../src/features/pages/home-feed');
const { homeFeedItemPresentation } = await import('../src/features/feed/home-feed-item');
const { homeFeedDestination, homeFeedResume } = await import('../src/features/pages/home-feed-destination');
const { preparedFeedCardReading } = await import('../src/kernel/fake/feed-card-reading');
const { feedCardTime } = await import('../src/features/feed/card-attribution');
const { m } = await import('../src/paraglide/messages.js');
const { locales } = await import('../src/paraglide/runtime.js');

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

type FollowingPost = Extract<FeedItem, { summary: { threadId: string } }>;

function reviewReply(): FollowingPost {
  return {
    id: 'current-review-reply',
    source: 'following',
    key: { owner: 'content', kind: 'post', route: 0, id: 'review-reply' },
    occurredAt: null,
    summary: {
      id: 'review-reply',
      threadId: 'review-thread',
      title: 'A reply to the review',
      createdAt: '2026-11-04T00:00:00Z',
      excerpt: 'The selected reply body',
      reviewContext: {
        target: {
          state: 'available',
          subject: { id: 'reviewed-subject', kind: 'schema:Book', label: { value: 'Reviewed book', language: 'en' } },
        },
        citation: {
          state: 'available',
          question: {
            id: 'reviewed-question',
            revision: 9,
            label: 'How clear was the ending?',
            grain: 'work',
            scale: { min: 0, max: 20, displayStep: 1 },
          },
          units: 17,
          voteRevision: 4,
        },
      },
      parentContext: {
        kind: 'reply',
        parent: {
          state: 'available',
          id: 'review-parent',
          revisionId: 'review-parent-revision',
          createdAt: '2026-11-03T00:00:00Z',
          author: null,
          excerpt: 'The parent reveals the ending',
          language: 'en',
          spoiler: true,
        },
      },
    },
    destination: {
      kind: 'post',
      id: 'review-reply',
      postId: 'review-reply',
      threadId: 'review-thread',
      title: 'A reply to the review',
    },
  };
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
    expect(reply.querySelector('[data-feed-card-parent]')).toBeNull();
    const review = rows[3]!;
    expect(review.querySelector('a')?.getAttribute('href')).toContain('/threads/');
    expect(review.querySelectorAll('[data-feed-card-review-context]')).toHaveLength(1);
    expect(review.querySelectorAll('[data-feed-card-reviewed-subject]')).toHaveLength(1);
    expect(review.querySelector('[data-feed-card-reviewed-subject] a')?.getAttribute('href')).toContain(
      `/${locale}/subjects/`,
    );
    expect(rows[6]!.querySelector('a')?.getAttribute('href')).toBe(`/${locale}/spaces/prepared-reading-room`);
    expect(rows[6]!.querySelectorAll('[data-home-carrier-state]')).toHaveLength(1);
    expect(rows[6]!.textContent?.match(/Prepared carrier Realm/g)).toHaveLength(1);
    expect(rows[6]!.querySelector('[data-home-carrier-link]')?.getAttribute('href')).toBe(
      `/${locale}/realms/prepared-realm`,
    );
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
    const reviewPost = render([reviewReply()], locale);
    const postRow = reviewPost.document.querySelector('li')!;
    for (const selector of [
      'h2',
      '[data-feed-card-review-context]',
      '[data-feed-card-reviewed-subject]',
      '[data-feed-review-citation]',
      '[data-feed-card-parent]',
    ])
      expect(postRow.querySelectorAll(selector)).toHaveLength(1);
    expect(postRow.querySelector('[data-feed-card-kind]')?.getAttribute('data-feed-card-kind')).toBe('reply');
    expect(postRow.querySelector('[data-feed-card-reviewed-subject] a')?.getAttribute('href')).toContain(
      `/${locale}/subjects/`,
    );
    expect(postRow.querySelector('[data-question-id]')?.getAttribute('data-units')).toBe('17');
    expect(postRow.querySelector('[data-question-id]')?.getAttribute('data-question-scale-max')).toBe('20');
    expect(postRow.querySelector('[data-feed-review-citation]')?.textContent).toContain(
      m.subject_community_recorded_scale({ min: '0', max: '20', step: '1' }, { locale }),
    );
    expect(postRow.querySelector('[data-feed-card-parent]')?.textContent).not.toContain(
      'The parent reveals the ending',
    );
    expect(postRow.querySelector('[data-feed-card-parent-post]')?.getAttribute('href')).toContain(
      '?post=review-parent#post-review-parent',
    );
    expect(postRow.querySelector('a a, a button, button a')).toBeNull();
    reviewPost.happyDOM.abort();
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
  expect(rows[1]!.querySelector('[data-home-carrier-link]')?.getAttribute('href')).toBe('/en/realms/prepared-realm');
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

test('independent card controls survive long names, row retirement and review-post page/viewer replacement', async () => {
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
    const client = new QueryClient();
    const session = (subject: string) => ({ state: 'signed-in', subject, csrfToken: `csrf-${subject}` });
    const ready = (item: FeedItem): HomeFeedResult => ({
      state: 'ready',
      page: {
        feedItems: [item],
        next: null,
        asOf: '2026-11-04T00:00:00Z',
        sources: { discovery: 'not_requested', following: 'ready', continue: 'not_requested' },
      },
    });
    const show = (result: HomeFeedResult) =>
      root.render(
        <QueryClientProvider client={client}>
          <HomeFeed locale="en" result={result} signedIn />
        </QueryClientProvider>,
      );
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

      const post = reviewReply();
      const context = post.summary.reviewContext!;
      client.setQueryData(['session'], session('reader-a'));
      await act(async () => show(ready(post)));
      const parent = () => host.querySelector('[data-feed-card-parent="available"]')!;
      const reveal = () => parent().querySelector('button')!;
      expect(host.textContent).toContain('Reviewed book');
      expect(host.textContent).toContain('How clear was the ending?');
      expect(host.querySelector('[data-question-id]')?.getAttribute('data-vote-revision')).toBe('4');
      expect(reveal().disabled).toBe(false);
      expect(reveal().getAttribute('aria-expanded')).toBe('false');
      await act(async () => reveal().click());
      expect(parent().textContent).toContain('The parent reveals the ending');
      expect(host.textContent?.match(/The parent reveals the ending/g)).toHaveLength(1);
      expect(reveal().getAttribute('aria-expanded')).toBe('true');
      await act(async () => reveal().click());
      expect(parent().textContent).not.toContain('The parent reveals the ending');
      await act(async () => reveal().click());
      const retiredReveal = reveal();

      if (context.citation.state !== 'available') throw new Error('Prepared citation missing');
      const refreshed: FollowingPost = {
        ...post,
        summary: {
          ...post.summary,
          reviewContext: {
            ...context,
            citation: {
              ...context.citation,
              units: 6,
              voteRevision: 5,
              question: { ...context.citation.question, revision: 10 },
            },
          },
        },
      };
      await act(async () => show(ready(refreshed)));
      await act(async () => retiredReveal.click());
      expect(host.querySelector('[data-question-id]')?.getAttribute('data-units')).toBe('6');
      expect(host.querySelector('[data-question-id]')?.getAttribute('data-question-revision')).toBe('10');
      expect(parent().textContent).not.toContain('The parent reveals the ending');
      expect(reveal().disabled).toBe(false);
      const previousViewerReveal = reveal();
      await act(async () => {
        client.setQueryData(['session'], session('reader-b'));
        show({ state: 'loading', code: 'loading' });
      });
      expect(host.querySelectorAll('[data-feed-card-review-context], [data-feed-card-parent]')).toHaveLength(0);
      expect(host.textContent).not.toContain('Reviewed book');
      await act(async () =>
        show(
          ready({
            ...post,
            summary: {
              ...post.summary,
              reviewContext: { target: { state: 'withheld' }, citation: { state: 'withheld' } },
            },
          }),
        ),
      );
      expect(host.querySelector('[data-feed-card-reviewed-subject]')).toBeNull();
      expect(host.querySelector('[data-question-id]')).toBeNull();
      expect(host.querySelector('[data-feed-review-citation="withheld"]')).not.toBeNull();
      expect(host.querySelector('[data-feed-card-parent-revision]')?.getAttribute('href')).toContain(
        '/posts/review-parent/revisions/review-parent-revision',
      );
      await act(async () => {
        client.setQueryData(['session'], session('reader-a'));
        show({ state: 'loading', code: 'loading' });
      });
      await act(async () => show(ready(post)));
      await act(async () => previousViewerReveal.click());
      expect(host.querySelector('[data-question-id]')?.getAttribute('data-units')).toBe('17');
      expect(host.querySelector('[data-question-id]')?.getAttribute('data-question-revision')).toBe('9');
      expect(reveal().disabled).toBe(false);
      expect(parent().textContent).not.toContain('The parent reveals the ending');
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.abort();
  }
});
