import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import {
  COMMUNITY_PAGE_LIMIT,
  composedCommunityRegion,
  readSubjectCommunity,
  withComposedCommunity,
} from '../src/features/pages/subject-community';
import { loadSubjectPage, pageContext } from '../src/features/pages/subject';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { communityAuthor, communitySubject, communityThread } from '../src/kernel/fake/subject-community';

const review = communityThread('review');
const discussion = communityThread('discussion');
const page = (threads: unknown[], next: unknown = null) => ({ threads, next });

// Each bad row invalidates even the valid row before it.
const malformed = [
  null,
  { threads: {}, next: null },
  page([], 42),
  page([review, review]),
  page(Array(21).fill(review)),
  ...[
    null,
    { ...review, title: {} },
    { ...review, authorId: null },
    { ...review, createdAt: 'invalid' },
    { ...review, kind: 'discussion' },
    { ...review, subjectIds: [discussion.id] },
    { ...review, firstPost: null },
    ...[
      { threadId: discussion.id },
      { boardId: discussion.boardId },
      { availability: 'withheld' },
      { body: null },
      { body: {} },
      { voteCitation: { questionId: 'bad-id', units: 4097, revision: 0 } },
    ].map((post) => ({ ...review, firstPost: { ...review.firstPost, ...post } })),
    { ...review, reactions: { upvote: 0 } },
  ].map((row) => page([review, row], 'native-next')),
];

test('native community windows fail malformed sources locally and retain honest continuations and one author batch', async () => {
  const requests: URL[] = [];
  let response: unknown;
  const fallback = createStoryRecordedKernelFetch();
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url);
      if (url.pathname.endsWith('/threads'))
        return Response.json(url.searchParams.get('kind') === 'review' ? response : page([discussion]));
      return fallback(request);
    }) as typeof fetch,
  });
  const loaded = await loadSubjectPage(client, communitySubject.id);
  if (loaded.kind !== 'page') throw new Error('Expected subject page');
  const plan = planReads(platformRegistry, loaded.page.document as CompositionDocument, pageContext(loaded.page));
  for (response of malformed) {
    requests.length = 0;
    const standalone = await readSubjectCommunity(client, communitySubject.id, ['review', 'review', 'discussion']);
    expect(standalone.regions.review?.state).toBe('unavailable');
    expect(standalone.regions.discussion?.state).toBe('ready');
    expect(requests).toHaveLength(3);
    expect(requests.filter((url) => url.pathname.endsWith('/threads'))).toHaveLength(2);
    expect(requests[0]!.searchParams.get('limit')).toBe('5');
    const reads = { ...loaded.page.reads };
    for (const [key, descriptor] of Object.entries(plan.reads))
      if (descriptor.kind === 'subjectThreads')
        reads[key] = { status: 200, body: descriptor.threadKind === 'review' ? response : page([discussion]) };
    requests.length = 0;
    const composed = await withComposedCommunity(client, {
      ...loaded,
      page: { ...loaded.page, reads, requestedRealm: communitySubject.id },
    });
    if (composed.kind !== 'page') throw new Error('Expected subject page');
    expect(composed.page.community!.regions.review?.state).toBe('unavailable');
    expect(composed.page.community!.regions.discussion).toMatchObject({
      state: 'ready',
      threads: [{ id: discussion.id }],
    });
    expect(composed.page.community!.regions.discussion?.contributionScope).toBeUndefined();
    expect(requests.map((url) => url.pathname)).toEqual(['/v1/accounts']);
    expect(requests[0]!.searchParams.get('ids')).toBe(communityAuthor.id);
  }
  const expected = Object.values(plan.reads).find((read) => read.kind === 'subjectThreads')!;
  for (const threads of [[], [{ ...review, title: null }]])
    for (const next of [null, 'opaque-native-next'])
      expect(composedCommunityRegion({ status: 200, body: page(threads, next) }, expected)).toMatchObject({
        state: 'ready',
        next,
        threads: threads.map(({ id, title }) => ({ id, title })),
      });
  expect(composedCommunityRegion({ status: 403, body: { code: 'platform_closed' } }, expected)).toEqual({
    state: 'closed',
  });
  expect(composedCommunityRegion(undefined, expected).state).toBe('unavailable');
  expect(composedCommunityRegion({ status: 200, body: page([]) }).state).toBe('unavailable');

  const reviewKey = Object.entries(plan.reads).find(([, descriptor]) =>
    descriptor.kind === 'subjectThreads' && descriptor.threadKind === 'review',
  )![0];
  const privateRow = {
    ...review,
    viewerReaction: 'love',
    firstPost: { ...review.firstPost, viewerReaction: 'sad' },
  };
  const reads = { ...loaded.page.reads, [reviewKey]: { status: 200, body: page([privateRow]) } };
  const publicPage = await withComposedCommunity(client, {
    kind: 'page',
    page: { ...loaded.page, reads, requestedReader: null },
  });
  if (publicPage.kind !== 'page') throw new Error('Expected public Subject page');
  const publicThread = publicPage.page.community!.regions.review!.state === 'ready'
    ? publicPage.page.community!.regions.review!.threads[0]!
    : undefined;
  expect(publicThread?.voteCitation).toEqual(review.firstPost.voteCitation);
  expect(publicThread?.reactions).toEqual(review.reactions);
  expect(publicThread).not.toHaveProperty('viewerReaction');
  const publicRead = publicPage.page.reads[reviewKey]!.body as { threads: Record<string, unknown>[] };
  expect(publicRead.threads[0]).not.toHaveProperty('viewerReaction');
  expect(publicRead.threads[0]!.firstPost).not.toHaveProperty('viewerReaction');

  const privatePage = await withComposedCommunity(client, {
    kind: 'page',
    page: { ...loaded.page, reads, requestedReader: communityAuthor.id },
  });
  if (privatePage.kind !== 'page') throw new Error('Expected private Subject page');
  expect(privatePage.page.community!.reader).toBe(communityAuthor.id);
  expect(privatePage.page.community!.regions.review).toMatchObject({
    state: 'ready',
    threads: [{ viewerReaction: 'love', voteCitation: review.firstPost.voteCitation, reactions: review.reactions }],
  });
  expect((privatePage.page.reads[reviewKey]!.body as { threads: Record<string, unknown>[] }).threads[0]!.firstPost)
    .toHaveProperty('viewerReaction', 'sad');

  for (const count of [1, 5, COMMUNITY_PAGE_LIMIT]) {
    const rows = Array.from({ length: count }, (_, index) => {
      const threadId = '01a1a000-0000-7000-8000-' + String(index + 100).padStart(12, '0');
      const postId = '01a1a000-0000-7000-8000-' + String(index + 200).padStart(12, '0');
      return { ...review, id: threadId, firstPost: { ...review.firstPost, id: postId, threadId } };
    });
    const projected = composedCommunityRegion(
      { status: 200, body: page(rows) },
      { ...expected, limit: count },
      true,
    );
    expect(projected.state).toBe('ready');
    if (projected.state === 'ready') {
      expect(projected.threads).toHaveLength(count);
      expect(projected.threads.every((thread) => thread.authorId === communityAuthor.id)).toBe(true);
      expect(projected.threads.every((thread) => thread.voteCitation?.revision === 2)).toBe(true);
      expect(projected.threads.every((thread) => thread.summary.length <= 280)).toBe(true);
      expect(projected.threads[0]!).not.toHaveProperty('body');
    }
  }

  const zeroCounts = composedCommunityRegion(
    { status: 200, body: page([{ ...review, reactions: {}, viewerReaction: null }]) },
    expected,
    true,
  );
  expect(zeroCounts).toMatchObject({ state: 'ready', threads: [{ reactions: {}, viewerReaction: null }] });
  const missingViewer = { ...review } as Record<string, unknown>;
  delete missingViewer.viewerReaction;
  const missingSlot = composedCommunityRegion({ status: 200, body: page([missingViewer]) }, expected, true);
  expect(missingSlot).toMatchObject({ state: 'ready', threads: [{ reactions: review.reactions }] });
  if (missingSlot.state === 'ready') expect(missingSlot.threads[0]).not.toHaveProperty('viewerReaction');
});
