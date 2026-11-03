import { expect, test } from 'bun:test';
import type { Static } from 'typebox';
import { createKernelClient } from '../src/index.ts';
import type { CONTENT_EVENTS } from '../src/kernel/content/events.ts';
import type { PostInput, RevisionInput } from '../src/kernel/content/model.ts';

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
  for (const visibility of ['draft', 'published', undefined] as const) {
    const body = { body: {}, licence: 'CC0-1.0', ...(visibility === undefined ? {} : { visibility }) };
    await client.threads({ id }).posts.post(body, options);
    await client.posts({ id }).revisions.post(body, options);
  }
  expect(sent.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual(
    Array.from({ length: 3 }, () => [`POST /v1/threads/${id}/posts`, `POST /v1/posts/${id}/revisions`]).flat(),
  );
  expect(await Promise.all(sent.map((request) => request.json()))).toEqual(
    ['draft', 'published', undefined].flatMap((visibility) => {
      const body = { body: {}, licence: 'CC0-1.0', ...(visibility === undefined ? {} : { visibility }) };
      return [body, body];
    }),
  );

  const typed = () => {
    const native: PostInput = { threadId: id, body: {}, licence: 'CC0-1.0', visibility: 'draft' };
    const revision: RevisionInput = { ...native, itemId: id, visibility: 'published' };
    // @ts-expect-error protected is not an authoring visibility
    client.threads({ id }).posts.post({ ...native, visibility: 'protected' }, options);
    // @ts-expect-error null does not mean preserve visibility
    client.posts({ id }).revisions.post({ ...revision, visibility: null }, options);
    // @ts-expect-error native command inputs use the same closed visibility
    const invalid: PostInput['visibility'] | RevisionInput['visibility'] = 'protected';
    return invalid;
  };
  expect(typeof typed).toBe('function');
});

type Published = Static<(typeof CONTENT_EVENTS)['com.rezics.content.post.published.v1']>;
type ExpectedPublication = {
  threadId: string;
  itemId: string;
  revisionId: string;
  actorId: string;
  placeId: string;
  kind: 'discussion' | 'review';
  subjectIds: string[];
  activityAt: string;
};
// Both directions pin required fields and their types; the key comparison excludes extra fields.
const publicationContract: [Published, keyof Published] extends [ExpectedPublication, keyof ExpectedPublication]
  ? [ExpectedPublication] extends [Published] ? true : false
  : false = true;

test('the derived publication event retains its exact pinned revision payload', () => {
  expect(publicationContract).toBe(true);
});
