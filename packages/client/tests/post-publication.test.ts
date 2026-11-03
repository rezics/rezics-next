import { expect, expectTypeOf, test } from 'bun:test';
import type { DocumentSnapshot } from '@rezics/document';
import type { Static } from 'typebox';
import type { CONTENT_EVENTS } from '../src/kernel/content/events.ts';
import type { PostInput, RevisionInput } from '../src/kernel/content/model.ts';
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

  const typed = async () => {
    const body = { body: snapshot, licence: 'CC0-1.0' };
    await client.threads({ id }).posts.post(body, options);
    await client.posts({ id }).revisions.post(body, options);
    for (const visibility of ['draft', 'published'] as const) {
      await client.threads({ id }).posts.post({ ...body, visibility }, options);
      await client.posts({ id }).revisions.post({ ...body, visibility }, options);
    }
    // @ts-expect-error protected is not an authoring visibility
    await client.threads({ id }).posts.post({ ...body, visibility: 'protected' }, options);
    // @ts-expect-error protected is not an authoring visibility
    await client.posts({ id }).revisions.post({ ...body, visibility: 'protected' }, options);
    // @ts-expect-error visibility may be omitted, but cannot be null
    await client.threads({ id }).posts.post({ ...body, visibility: null }, options);
    // @ts-expect-error visibility may be omitted, but cannot be null
    await client.posts({ id }).revisions.post({ ...body, visibility: null }, options);
  };
  expect(typeof typed).toBe('function');
  expectTypeOf<Pick<PostInput, 'visibility'>>().toEqualTypeOf<{ readonly visibility?: 'published' | 'draft' }>();
  expectTypeOf<Pick<RevisionInput, 'visibility'>>().toEqualTypeOf<{ readonly visibility?: 'published' | 'draft' }>();
});

test('the derived publication event retains its exact required payload and creation events', () => {
  type Published = Static<(typeof CONTENT_EVENTS)['com.rezics.content.post.published.v1']>;
  expectTypeOf<Published>().toEqualTypeOf<{
    threadId: string;
    itemId: string;
    revisionId: string;
    actorId: string;
    placeId: string;
    kind: 'discussion' | 'review';
    subjectIds: string[];
    activityAt: string;
  }>();
  expectTypeOf<Static<(typeof CONTENT_EVENTS)['com.rezics.content.post.created.v1']>>().toEqualTypeOf<Published>();
  type RevisionCreated = Static<(typeof CONTENT_EVENTS)['com.rezics.content.revision.created.v1']>;
  expectTypeOf<Omit<RevisionCreated, 'previousSubjectIds'>>().toEqualTypeOf<Published>();
  expectTypeOf<RevisionCreated['previousSubjectIds']>().toEqualTypeOf<string[] | undefined>();
});
