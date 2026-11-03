import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test('post history and exact revision reads keep their compatible route addresses', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({});
    }) as typeof fetch,
  });
  const postId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const revisionId = '019a1b2c-3d4e-7f00-8a00-000000000002';

  await client.posts({ id: postId }).revisions.get({ query: { limit: 20 } });
  await client.posts({ id: postId }).revisions({ revisionId }).get({ query: { editionIdentity: 'true' } });

  expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
    `GET /v1/posts/${postId}/revisions`,
    `GET /v1/posts/${postId}/revisions/${revisionId}`,
  ]);
  expect(new URL(requests[1]!.url).searchParams.get('editionIdentity')).toBe('true');

  const typed = async () => {
    await client.posts({ id: postId }).revisions({ revisionId }).get({ query: { editionIdentity: 'true' } });
    // @ts-expect-error Only the edition identity compatibility value is supported.
    await client.posts({ id: postId }).revisions({ revisionId }).get({ query: { editionIdentity: 'false' } });
  };
  expect(typeof typed).toBe('function');
});
