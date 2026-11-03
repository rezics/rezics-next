import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '../src/index.ts';

type PostHistoryGet = ReturnType<ReturnType<KernelClient['posts']>['revisions']['get']>;
type PostHistoryPage = NonNullable<Awaited<PostHistoryGet>['data']>['page'];

test('post history and exact revision reads keep their compatible route addresses', async () => {
  const requests: Request[] = [];
  const postId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const revisionId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const authorId = '019a1b2c-3d4e-7f00-8a00-000000000003';
  const questionId = '019a1b2c-3d4e-7f00-8a00-000000000004';
  const subjectId = '019a1b2c-3d4e-7f00-8a00-000000000005';
  const headRevisionId = '019a1b2c-3d4e-7f00-8a00-000000000006';
  const boardId = '019a1b2c-3d4e-7f00-8a00-000000000007';
  const conversationId = '019a1b2c-3d4e-7f00-8a00-000000000008';
  const page: PostHistoryPage = {
    viewer: { kind: 'anonymous' },
    conversation: {
      id: conversationId,
      kind: 'review',
      title: 'History',
      authorId,
      boardId,
      subjectIds: [subjectId],
      createdAt: '2026-10-01T00:00:00.000Z',
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
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    place: { kind: 'global', id: boardId },
    head: {
      postId,
      revisionId: headRevisionId,
      state: 'current',
      authorId,
      createdAt: '2026-10-01T00:00:00.000Z',
      revisedAt: '2026-10-02T00:00:00.000Z',
    },
    authors: { state: 'current', retryable: false, items: [{ id: authorId, state: 'concealed' }] },
    mentions: { state: 'current', retryable: false, items: [] },
    subjects: { state: 'current', retryable: false, limit: 4, items: [] },
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
    media: { state: 'current', retryable: false, items: [] },
    actions: {
      state: 'current',
      retryable: false,
      references: [
        { type: 'content.post', id: postId, sourceRevisionId: revisionId, state: 'withheld', operations: [] },
      ],
    },
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
  };
  const client: KernelClient = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new URL(request.url).pathname.endsWith('/revisions')
        ? Response.json({
            revisions: [{ revisionId, voteCitation: { questionId, units: 0, revision: 1 } }],
            next: null,
            page,
          })
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
  expect(history.data?.page.head.revisionId).toBe(headRevisionId);
  expect(history.data?.page.reviewScores.items[0]?.revisionId).toBe(revisionId);
  expect(history.data?.page.reviewScores.items[0]?.revisionId).not.toBe(history.data?.page.head.revisionId);
  expect(history.data?.page.authors.items[0]?.state).toBe('concealed');
  expect(history.data?.page.actions.references[0]?.state).toBe('withheld');
  expect(history.data).toMatchObject({
    page: {
      authors: { items: [{ id: authorId, state: 'concealed' }] },
      reviewScores: {
        items: [
          {
            revisionId,
            citation: { questionId, units: 0, revision: 1 },
            question: { id: questionId, revision: 1, scale: { min: 0, max: 20, displayStep: 1 } },
          },
        ],
      },
      actions: { references: [{ sourceRevisionId: revisionId, state: 'withheld' }] },
    },
  });
  expect(revision.data?.editionIdentity?.subjects[0]?.kind).toBe('withheld');

  expectTypeOf<PostHistoryPage['head']['revisionId']>().toEqualTypeOf<string | null>();
  expectTypeOf<PostHistoryPage['reviewScores']['items'][number]['revisionId']>().toEqualTypeOf<string>();
  expectTypeOf<
    Extract<PostHistoryPage['authors']['items'][number], { state: 'concealed' }>['state']
  >().toEqualTypeOf<'concealed'>();
  expectTypeOf<
    Extract<PostHistoryPage['actions']['references'][number], { type: 'content.post' }>['state']
  >().toEqualTypeOf<'current' | 'withheld'>();

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

test('generated history contract includes the full page and bounded disclosure variants', async () => {
  const contract = await Bun.file(new URL('../../../contracts/openapi.json', import.meta.url)).json();
  const history = contract.paths['/v1/posts/{id}/revisions'].get.responses['200'].content['application/json'].schema;
  expect(history.required).toEqual(['revisions', 'next', 'page']);
  const page = history.properties.page;
  expect(page.required).toEqual([
    'viewer',
    'conversation',
    'board',
    'place',
    'head',
    'authors',
    'mentions',
    'subjects',
    'reviewScores',
    'media',
    'actions',
    'navigation',
    'currentness',
    'retry',
  ]);
  const concealed = page.properties.authors.properties.items.items.anyOf[1];
  expect(concealed.additionalProperties).toBe(false);
  expect(Object.keys(concealed.properties).sort()).toEqual(['id', 'state']);
  const score = page.properties.reviewScores.properties.items.items.anyOf[0];
  expect(score.required).toEqual(['revisionId', 'state', 'citation', 'question']);
  expect(score.properties.citation.required).toContain('revision');
  expect(score.properties.question.required).toContain('scale');
  const source = page.properties.actions.properties.references.items.anyOf[1];
  expect(source.required).toContain('sourceRevisionId');
  expect(source.properties.state.enum).toContain('withheld');
});
