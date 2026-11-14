import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { FeedCardSubjectContext } from '../src/features/feed/card-presentation';
import { homeFeedItemPresentation } from '../src/features/feed/home-feed-item';
import { homeFeedReaction } from '../src/features/feed/home-feed-reaction';
import type { FeedItem } from '../src/features/pages/home-feed-read';

type FollowingPost = Extract<FeedItem, { summary: { threadId: string } }>;
type ReviewContext = NonNullable<FollowingPost['summary']['reviewContext']>;

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
const populated: ReviewContext = {
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
};

function review(context?: ReviewContext): FeedItem {
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
      ...(context === undefined ? {} : { reviewContext: context }),
    },
    destination: { kind: 'thread', id: ids.thread, title: 'Review title' },
  };
}

function followingPost(context?: ReviewContext): FollowingPost {
  return {
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
      ...(context === undefined ? {} : { reviewContext: context }),
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
}

function html(item: FeedItem, origin?: { key: string; isCurrent(): boolean }) {
  const presentation = homeFeedItemPresentation(item, 'en', origin);
  return renderToStaticMarkup(
    createElement('div', null, presentation.context, presentation.metadata, presentation.preview),
  );
}

test('review threads and following posts render only current Subject and exact citation witnesses', () => {
  const post = followingPost(populated);
  expect('kind' in post.summary).toBe(false);
  for (const item of [review(populated), post]) {
    const markup = html(item);
    expect(markup).toContain('Current Subject');
    expect(markup).toContain(ids.subject);
    expect(markup).toContain('lang="en"');
    expect(markup).not.toContain('Stale Subject label');
    expect(markup).toContain('How clear was this edition?');
    expect(markup).toContain('17 units');
    expect(markup).toContain(`data-question-id="${ids.question}"`);
    expect(markup).toContain('data-question-revision="9"');
    expect(markup).toContain('data-vote-revision="4"');
  }
});

test('native target and citation states disclose independently on following posts and override discovery metadata', () => {
  const targets: ReviewContext['target'][] = [populated.target, { state: 'absent' }, { state: 'withheld' }];
  const citations: ReviewContext['citation'][] = [populated.citation, { state: 'absent' }, { state: 'withheld' }];
  for (const target of targets) {
    for (const citation of citations) {
      for (const item of [followingPost({ target, citation }), review({ target, citation })]) {
        const markup = renderToStaticMarkup(createElement(FeedCardSubjectContext, { item, locale: 'en' }));
        expect(markup.includes('data-feed-card-reviewed-subject')).toBe(target.state === 'available');
        expect(markup.includes('Current Subject')).toBe(target.state === 'available');
        expect(markup.includes(ids.subject)).toBe(target.state === 'available');
        expect(markup.includes(`data-question-id="${ids.question}"`)).toBe(citation.state === 'available');
        expect(markup.includes(ids.question)).toBe(citation.state === 'available');
        expect(markup.includes('How clear was this edition?')).toBe(citation.state === 'available');
        expect(markup.includes('17 units')).toBe(citation.state === 'available');
        expect(markup.includes('No answer is currently stored')).toBe(citation.state === 'absent');
        expect(markup.includes('No recorded rating is disclosed')).toBe(citation.state === 'withheld');
        expect(markup).not.toContain('Stale Subject label');
        expect(markup).not.toContain(ids.staleSubject);
      }
    }
  }
});

test('only review rows without native context retain the discovery Subject fallback', () => {
  expect(html(review())).toContain('Stale Subject label');
  const post = html(followingPost());
  expect(post).not.toContain('data-feed-card-review-context');
  expect(post).not.toContain('data-feed-review-citation');
  expect(post).toContain('Current parent author');
});

test('review-post context preserves exact parent destinations and current spoiler reveal controls', () => {
  const item = followingPost(populated);
  const markup = html(item, { key: 'current-page', isCurrent: () => true });
  expect(markup).toContain('Current Subject');
  expect(markup).toContain('How clear was this edition?');
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
  expect(homeFeedReaction(current, { signedIn: true })).toBeUndefined();
  const mismatch = {
    ...current,
    summary: { ...current.summary, reactionTarget: { targetKind: 'thread' as const, targetId: ids.staleSubject } },
  } as FeedItem;
  expect(homeFeedReaction(mismatch, { signedIn: true })).toBeUndefined();
});
