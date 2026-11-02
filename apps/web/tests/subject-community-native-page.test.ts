import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import {
  composedCommunityRegion,
  readSubjectCommunity,
  withComposedCommunity,
} from '../src/features/pages/subject-community';
import { loadSubjectPage, pageContext } from '../src/features/pages/subject';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { communityAuthor, communitySubject, communityThread } from '../src/kernel/fake/subject-community';

const review = communityThread('review');
const discussion = communityThread('discussion');
const expected = {
  kind: 'subjectThreads',
  id: communitySubject.id,
  place: communitySubject.id,
  threadKind: 'review',
  limit: 5,
} as const;
const page = (threads: unknown[], next: unknown = null) => ({ threads, next });

// Each failure must discard the whole source, including its otherwise valid first row.
const malformed = [
  null,
  {},
  { threads: {}, next: null },
  page([], 42),
  ...[
    null,
    {},
    { ...review, id: '' },
    { ...review, authorId: 4 },
    { ...review, boardId: null },
    { ...review, title: {} },
    { ...review, createdAt: 'invalid' },
    { ...review, kind: 'discussion' },
    { ...review, subjectIds: [] },
    { ...review, subjectIds: null },
    { ...review, visibility: 'hidden' },
    { ...review, availability: 'erased' },
    { ...review, firstPost: null },
    ...[
      { threadId: discussion.id },
      { boardId: discussion.boardId },
      { id: null },
      { availability: 'withheld' },
      { visibility: 'hidden' },
      { body: null },
      { body: {} },
      {
        body: {
          version: 'rezics-document-v1',
          profile: 'blocks',
          doc: { type: 'doc', content: [{ type: 'paragraph', content: 'bad' }] },
        },
      },
    ].map((post) => ({ ...review, firstPost: { ...review.firstPost, ...post } })),
  ].map((row) => page([review, row], 'native-next')),
  page([review, review]),
  page(Array(21).fill(review)),
];

test('malformed native pages fail only their community source in both readers without extra reads', async () => {
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
    expect(requests.map((url) => url.pathname)).toEqual([
      `/v1/subjects/${communitySubject.id}/threads`,
      `/v1/subjects/${communitySubject.id}/threads`,
      '/v1/accounts',
    ]);
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
});

test('native empty and sparse windows retain opaque continuations, bounds, null titles and closed outcomes', async () => {
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
  expect(composedCommunityRegion({ status: 404, body: {} }, expected).state).toBe('unavailable');
  expect(composedCommunityRegion(undefined, expected).state).toBe('unavailable');
  expect(composedCommunityRegion({ status: 200, body: page([]) }).state).toBe('unavailable');
  const requests: URL[] = [];
  const threads = Array.from({ length: 20 }, (_, n) => {
    const id = `01a1a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
    return { ...review, id, firstPost: { ...review.firstPost, threadId: id } };
  });
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      return Response.json(
        url.pathname.endsWith('/threads') ? page(threads, 'native-next') : { accounts: [communityAuthor] },
      );
    }) as typeof fetch,
  });
  const result = await readSubjectCommunity(client, communitySubject.id, ['review'], true, 'previous');
  expect(result.regions.review).toMatchObject({ state: 'ready', next: 'native-next', contributionScope: 'global' });
  expect(requests).toHaveLength(2);
  expect(requests[0]!.searchParams.get('limit')).toBe('20');
  expect(requests[0]!.searchParams.get('cursor')).toBe('previous');
  expect(JSON.stringify(result)).not.toMatch(/firstPost|revisionId|sha256/);
});
