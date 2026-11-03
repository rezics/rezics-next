import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { homeFeedItemPresentation } from '../src/features/feed/home-feed-item';
import { homeFeedReaction } from '../src/features/feed/home-feed-reaction';
import type { FeedItem } from '../src/features/pages/home-feed-read';

const ids = {
  thread: '00000000-0000-7000-8000-000000000011',
  subject: '00000000-0000-7000-8000-000000000012',
  staleSubject: '00000000-0000-7000-8000-000000000013',
  question: '00000000-0000-7000-8000-000000000014',
  post: '00000000-0000-7000-8000-000000000015',
  parent: '00000000-0000-7000-8000-000000000016',
  parentRevision: '00000000-0000-7000-8000-000000000017',
  author: '00000000-0000-7000-8000-000000000018',
};

function review(
  context: NonNullable<
    Extract<FeedItem, { source: 'discovery' }>['summary'] extends infer S
      ? S extends { reviewContext?: infer C }
        ? C
        : never
      : never
  >,
): FeedItem {
  return {
    id: 'review-activity',
    source: 'discovery',
    key: { owner: 'content', kind: 'review', route: 12, id: ids.thread },
    occurredAt: null,
    summary: {
      id: ids.thread,
      kind: 'review',
      title: 'Review title',
      author: { displayName: 'Reviewer', handle: 'reviewer' },
      excerpt: 'Review body excerpt',
      subject: { id: ids.staleSubject, title: 'Stale Subject label' },
      reviewContext: context,
    },
    destination: { kind: 'thread', id: ids.thread, title: 'Review title' },
  };
}

function html(item: FeedItem, origin?: { key: string; isCurrent(): boolean }) {
  const presentation = homeFeedItemPresentation(item, 'en', origin);
  return renderToStaticMarkup(
    createElement('div', null, presentation.context, presentation.metadata, presentation.preview),
  );
}

test('review cards render only current Subject and exact citation witnesses', () => {
  const item = review({
    target: {
      state: 'available',
      subject: { id: ids.subject, kind: 'schema:Book', label: { value: 'Current Subject', language: 'en' } },
    },
    citation: {
      state: 'available',
      question: {
        id: ids.question,
        revision: 9,
        label: 'How clear was this edition?',
        grain: 'work',
        scale: { min: 0, max: 20, displayStep: 1 },
      },
      units: 17,
      voteRevision: 4,
    },
  });
  const markup = html(item);
  expect(markup).toContain('Current Subject');
  expect(markup).toContain(ids.subject);
  expect(markup).not.toContain('Stale Subject label');
  expect(markup).toContain('How clear was this edition?');
  expect(markup).toContain('17 units');
  expect(markup).toContain(`data-question-id="${ids.question}"`);
  expect(markup).toContain('data-question-revision="9"');
  expect(markup).toContain('data-vote-revision="4"');
});

test('withheld and absent citations keep their distinct disclosure states', () => {
  const withheld = html(review({ target: { state: 'withheld' }, citation: { state: 'withheld' } }));
  expect(withheld).toContain('No recorded rating is disclosed');
  expect(withheld).not.toContain('Stale Subject label');
  const absent = html(review({ target: { state: 'absent' }, citation: { state: 'absent' } }));
  expect(absent).toContain('No answer is currently stored');
  expect(absent).not.toContain('No recorded rating is disclosed');
  expect(absent).not.toContain('Stale Subject label');
});

test('reply cards keep exact post and revision destinations and hide spoiler text until a current reveal', () => {
  const item: FeedItem = {
    id: 'reply-activity',
    source: 'following',
    key: { owner: 'content', kind: 'post', route: 12, id: ids.post },
    occurredAt: null,
    summary: {
      id: ids.post,
      threadId: ids.thread,
      title: 'Review title',
      createdAt: '2026-11-04T00:00:00Z',
      excerpt: 'Selected reply excerpt',
      parentContext: {
        kind: 'reply',
        parent: {
          state: 'available',
          id: ids.parent,
          revisionId: ids.parentRevision,
          createdAt: '2026-11-03T00:00:00Z',
          author: { id: ids.author, displayName: 'Current parent author', handle: 'parent_author' },
          excerpt: 'Spoiler text stays hidden',
          language: 'fr',
          spoiler: true,
        },
      },
    },
    destination: { kind: 'post', id: ids.post, threadId: ids.thread, postId: ids.post, title: 'Review title' },
  };
  const markup = html(item, { key: 'current-page', isCurrent: () => true });
  expect(markup).toContain('Current parent author');
  expect(markup).toContain('Reveal spoiler');
  expect(markup).not.toContain('Spoiler text stays hidden');
  expect(markup).toContain(`post=${ids.parent}#post-${ids.parent}`);
  expect(markup).toContain(`/en/posts/${ids.parent}/revisions/${ids.parentRevision}`);

  const retired = html(item, { key: 'retired-page', isCurrent: () => false });
  expect(retired).toContain('disabled=""');
  expect(retired).not.toContain('Spoiler text stays hidden');
});

test('reaction receiving preserves exact target, empty totals, viewer selection and page freshness', () => {
  const item = review({ target: { state: 'absent' }, citation: { state: 'absent' } });
  if (item.source !== 'discovery' || !('kind' in item.summary) || item.summary.kind !== 'review') throw new Error();
  const current = {
    ...item,
    summary: {
      ...item.summary,
      reactionTarget: { targetKind: 'thread' as const, targetId: ids.thread },
      reactions: {},
      viewerReaction: null,
    },
  } as FeedItem;
  const reaction = homeFeedReaction(current, {
    signedIn: true,
    origin: { key: 'page-1', isCurrent: () => true },
    reactionsAsOf: null,
    hasReactionFreshness: true,
  });
  expect(reaction).toMatchObject({
    target: { kind: 'thread', id: ids.thread },
    counts: {},
    value: null,
    sourceWatermark: null,
  });
  expect(reaction?.reactionOrigin?.key).toBe('page-1');
  const mismatch = {
    ...current,
    summary: { ...current.summary, reactionTarget: { targetKind: 'thread' as const, targetId: ids.staleSubject } },
  } as FeedItem;
  expect(homeFeedReaction(mismatch, { signedIn: true })).toBeUndefined();
});
