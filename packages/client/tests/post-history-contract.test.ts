import { expect, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '../src/index.ts';

test('post history and exact revision reads keep their compatible route addresses', async () => {
  const requests: Request[] = [];
  const postId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const revisionId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const authorId = '019a1b2c-3d4e-7f00-8a00-000000000003';
  const questionId = '019a1b2c-3d4e-7f00-8a00-000000000004';
  const subjectId = '019a1b2c-3d4e-7f00-8a00-000000000005';
  const client: KernelClient = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new URL(request.url).pathname.endsWith('/revisions')
        ? Response.json({
            revisions: [{ revisionId, voteCitation: { questionId, units: 0, revision: 1 } }],
            next: null,
            page: {
              authors: { state: 'current', retryable: false, items: [{ id: authorId, state: 'concealed' }] },
              reviewScores: {
                state: 'current',
                retryable: false,
                items: [
                  {
                    revisionId,
                    state: 'available',
                    citation: { questionId, units: 0, revision: 1 },
                    question: { id: questionId, revision: 1, label: 'Rating', grain: 'work', scale: { min: 0, max: 20, displayStep: 1 } },
                  },
                ],
              },
              actions: {
                state: 'current',
                retryable: false,
                references: [{ type: 'content.post', id: postId, sourceRevisionId: revisionId, state: 'withheld', operations: [] }],
              },
            },
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
  expect(history.data).toMatchObject({
    page: {
      authors: { items: [{ id: authorId, state: 'concealed' }] },
      reviewScores: { items: [{ revisionId, citation: { units: 0 } }] },
      actions: { references: [{ sourceRevisionId: revisionId, state: 'withheld' }] },
    },
  });
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
    // @ts-expect-error Only the edition identity compatibility value is supported.
    await client.posts({ id: postId }).revisions({ revisionId }).get({ query: { editionIdentity: 'false' } });
  };
  expect(typeof typed).toBe('function');
});
