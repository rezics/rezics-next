import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '../src/index.ts';

type Post = ReturnType<KernelClient['posts']>;
type HistoryPage = NonNullable<Awaited<ReturnType<Post['revisions']['get']>>['data']>;

expectTypeOf<ReturnType<typeof createKernelClient>>().toEqualTypeOf<KernelClient>();

test('post history and exact revision reads keep their compatible route addresses', async () => {
  const requests: Request[] = [];
  const postId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const revisionId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const authorId = '019a1b2c-3d4e-7f00-8a00-000000000003';
  const questionId = '019a1b2c-3d4e-7f00-8a00-000000000004';
  const subjectId = '019a1b2c-3d4e-7f00-8a00-000000000005';
  const headRevisionId = '019a1b2c-3d4e-7f00-8a00-000000000008';
  const createdAt = '2026-11-04T00:00:00Z';
  const threadId = '019a1b2c-3d4e-7f00-8a00-000000000006';
  const boardId = '019a1b2c-3d4e-7f00-8a00-000000000007';
  const client: KernelClient = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new URL(request.url).pathname.endsWith('/revisions')
        ? Response.json({
            revisions: [
              {
                id: postId,
                threadId,
                revisionId,
                authorId,
                boardId,
                route: 1,
                parentId: null,
                licence: 'CC0-1.0',
                subjectIds: [subjectId],
                mediaIds: [],
                visibility: 'published',
                securityRevision: '1',
                availability: 'available',
                createdAt,
                revisedAt: null,
                sha256: 'a'.repeat(64),
                body: {
                  version: 'rezics-document-v1',
                  profile: 'text',
                  doc: { type: 'doc', content: [{ type: 'paragraph' }] },
                },
                voteCitation: { questionId, units: 0, revision: 1 },
              },
            ],
            next: null,
            page: {
              viewer: { kind: 'anonymous' },
              conversation: {
                id: threadId,
                kind: 'review',
                title: 'Historical review',
                authorId,
                boardId,
                subjectIds: [subjectId],
                createdAt,
              },
              board: {
                id: boardId,
                realmId: null,
                community: null,
                route: 1,
                title: 'Reviews',
                purpose: 'reviews',
                visibility: 'published',
                securityRevision: '1',
                availability: 'available',
                createdAt,
              },
              place: { kind: 'global', id: boardId },
              head: {
                postId,
                revisionId: headRevisionId,
                state: 'current',
                authorId,
                createdAt,
                revisedAt: null,
              },
              mentions: { state: 'current', retryable: false, items: [] },
              subjects: {
                state: 'current',
                retryable: false,
                limit: 4,
                items: [{ id: subjectId, state: 'concealed', summary: null }],
              },
              media: { state: 'current', retryable: false, items: [] },
              navigation: {
                exact: [{ postId, revisionId }],
                compareToHead: [{ postId, fromRevisionId: revisionId, toRevisionId: headRevisionId }],
              },
              currentness: {
                source: 'current',
                conversation: 'current',
                board: 'current',
                place: 'current',
                head: 'current',
                authors: 'current',
                mentions: 'current',
                subjects: 'current',
                reviewScores: 'current',
                media: 'current',
                actions: 'current',
              },
              retry: { state: 'none' },
              authors: {
                state: 'current',
                retryable: false,
                items: [{ id: authorId, state: 'concealed' }],
              },
              reviewScores: {
                state: 'current',
                retryable: false,
                items: [
                  {
                    revisionId,
                    state: 'available',
                    citation: { questionId, units: 0, revision: 1 },
                    question: {
                      id: questionId,
                      revision: 1,
                      label: 'Rating',
                      grain: 'work',
                      scale: { min: 0, max: 20, displayStep: 1 },
                    },
                  },
                ],
              },
              actions: {
                state: 'current',
                retryable: false,
                references: [
                  {
                    type: 'content.post',
                    id: postId,
                    sourceRevisionId: revisionId,
                    state: 'withheld',
                    operations: [],
                  },
                ],
              },
            },
          } satisfies HistoryPage)
        : Response.json({
            post: {},
            editionIdentity: {
              postId,
              revisionId,
              sha256: 'a'.repeat(64),
              revisionCreatedAt: null,
              subjects: [{ id: subjectId, kind: 'withheld', label: null }],
            },
          });
    }) as typeof fetch,
  });

  const history = await client.posts({ id: postId }).revisions.get({ query: { limit: 20 } });
  const revision = await client
    .posts({ id: postId })
    .revisions({ revisionId })
    .get({ query: { editionIdentity: 'true' } });

  expect(history.data?.revisions[0]?.voteCitation?.units).toBe(0);
  expect(history.error).toBeNull();
  const page = history.data!.page;
  expect(page.conversation.kind).toBe('review');
  expect(page.board.purpose).toBe('reviews');
  expect(page.head.revisionId).toBe(headRevisionId);
  expect(page.authors.items[0]).toEqual({ id: authorId, state: 'concealed' });
  const author = page.authors.items[0]!;
  if (author.state === 'concealed') {
    // @ts-expect-error Concealed authors do not expose presentation fields.
    expect(author.displayName).toBeUndefined();
  }
  const score = page.reviewScores.items[0]!;
  expect(score.state).toBe('available');
  if (score.state === 'available') {
    expectTypeOf(score.citation.units).toEqualTypeOf<number>();
    expect(score.citation).toEqual({ questionId, units: 0, revision: 1 });
    expect(score.question).toMatchObject({
      id: questionId,
      revision: 1,
      scale: { min: 0, max: 20 },
    });
  }
  const source = page.actions.references[0]!;
  expect(source.state).toBe('withheld');
  expect(source.operations).toEqual([]);
  if (source.type === 'content.post') expect(source.sourceRevisionId).toBe(revisionId);
  expect(page.subjects.items[0]).toEqual({
    id: subjectId,
    state: 'concealed',
    summary: null,
  });
  expect(page.navigation.exact).toEqual([{ postId, revisionId }]);
  expect(page.navigation.compareToHead).toEqual([{ postId, fromRevisionId: revisionId, toRevisionId: headRevisionId }]);
  expect(page.currentness.reviewScores).toBe('current');
  expect(page.retry).toEqual({ state: 'none' });
  expect(revision.data?.editionIdentity?.subjects[0]?.kind).toBe('withheld');

  expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
    `GET /v1/posts/${postId}/revisions`,
    `GET /v1/posts/${postId}/revisions/${revisionId}`,
  ]);
  expect(new URL(requests[1]!.url).searchParams.get('editionIdentity')).toBe('true');

  const typed = async () => {
    await client
      .posts({ id: postId })
      .revisions({ revisionId })
      .get({ query: { editionIdentity: 'true' } });
    await client
      .posts({ id: postId })
      .revisions({ revisionId })
      // @ts-expect-error Only the edition identity compatibility value is supported.
      .get({ query: { editionIdentity: 'false' } });
  };
  expect(typeof typed).toBe('function');
});
