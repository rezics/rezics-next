import { expect, test } from 'bun:test';
import type { DocumentSnapshot } from '@rezics/document';
import { createKernelClient } from '../src/index.ts';

test('native post authoring sends draft, published and omitted visibility', async () => {
  const sent: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      sent.push(new Request(input, init));
      return Response.json({});
    }) as typeof fetch,
  });
  const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const options = { headers: { 'idempotency-key': 'authoring' } };
  const snapshot: DocumentSnapshot = {
    version: 'rezics-document-v1',
    profile: 'text',
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reply' }] }] },
  };
  for (const visibility of ['draft', 'published', undefined] as const) {
    const body = { body: snapshot, licence: 'CC0-1.0', ...(visibility === undefined ? {} : { visibility }) };
    await client.threads({ id }).posts.post(body, options);
    await client.posts({ id }).revisions.post(body, options);
  }
  expect(sent.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual(
    Array.from({ length: 3 }, () => [`POST /v1/threads/${id}/posts`, `POST /v1/posts/${id}/revisions`]).flat(),
  );
  expect(await Promise.all(sent.map((request) => request.json()))).toEqual(
    ['draft', 'published', undefined].flatMap((visibility) => {
      const body = { body: snapshot, licence: 'CC0-1.0', ...(visibility === undefined ? {} : { visibility }) };
      return [body, body];
    }),
  );
});
