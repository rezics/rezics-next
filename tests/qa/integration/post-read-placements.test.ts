import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { POST_READ_COST } from '../../../services/main/src/modules/post/read.ts';
import { startMediaStack } from './media-support.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

interface PostRead { profile: string; id: string; placements: Array<{ book: string; occurrence: string }>;
  placementsTruncated: boolean }

test('Post read lists the readable Books that place the Post, with its occurrence in each', async () => {
  const stack = await startMediaStack('post-read-placements');
  try {
    const a = await stack.member('post-read-owner');
    const b = await stack.member('post-read-guest');
    const store = stack.objects('semantic/structure/');
    await store.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof store }).structureObjects = store;
    const book = async (title: string) => {
      const types = ['https://schema.org/Book'];
      const created = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
        a.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
      if (!created.work || !created.mainVersion) throw new Error('Book was not created');
      await a.grant(`work:edit:${created.work}`, 'work.edit');
      await a.grant(`work:read:${created.work}`, 'work.read');
      const made = await json<{ structure: string; revision: string }>(await a.send('POST', '/v1/compositions',
        { profile: 'book-composition', work: created.work, mainVersion: created.mainVersion, actingSubject: a.actor }), 201);
      return { work: created.work, ...made };
    };
    const first = await book(`Placed Book ${randomUUID()}`);
    const second = await book(`Reused Book ${randomUUID()}`);
    const created = await json<{ post: string; occurrence: string; compositionRevision: string }>(await a.send('POST',
      `/v1/works/${short(first.work)}/chapters`, { profile: 'book-chapter-create-v1', title: 'Chapter one',
        language: 'en', direction: 'ltr', parent: first.structure, position: 'last',
        expectedCompositionHead: first.revision, actingSubject: a.actor }));
    await a.grant(`work:read:${created.post}`, 'work.read');
    const read = (reader: typeof a) => reader.read(`/v1/posts/${short(created.post)}?actingSubject=${encodeURIComponent(reader.actor)}`);

    expect(await json<PostRead>(await read(a))).toMatchObject({ profile: 'post-read-v2', id: created.post,
      placements: [{ book: first.work, occurrence: created.occurrence }], placementsTruncated: false });

    // The same Post reused in a second Book keeps one text and gains a second occurrence.
    const reused = await json<{ occurrences: string[] }>(await a.send('POST',
      `/v1/compositions/${short(second.structure)}/changes`, { profile: 'book-composition',
        expectedHead: second.revision, actingSubject: a.actor, operations: [{ op: 'insert', parent: second.structure,
          position: 'last', role: 'chapter', target: created.post, label: { value: 'Reused', language: 'en' } }] }));
    const both = await json<PostRead>(await read(a));
    expect(both.placements).toEqual([
      { book: first.work, occurrence: created.occurrence }, { book: second.work, occurrence: reused.occurrences[0]! },
    ].sort((left, right) => left.book.localeCompare(right.book)));
    expect(both.placements.length).toBeLessThanOrEqual(POST_READ_COST.placements);

    // Reading the Post never reveals a Book its reader may not read.
    await b.grant(`work:read:${created.post}`, 'work.read');
    expect(await json<PostRead>(await read(b))).toMatchObject({ id: created.post, placements: [] });

    // Removing the occurrence leaves the Post and drops only that placement.
    await json(await a.send('POST', `/v1/compositions/${short(first.structure)}/changes`, {
      profile: 'book-composition', expectedHead: created.compositionRevision, actingSubject: a.actor,
      operations: [{ op: 'remove', occurrence: created.occurrence }] }));
    expect(await json<PostRead>(await read(a))).toMatchObject({
      placements: [{ book: second.work, occurrence: reused.occurrences[0] }], placementsTruncated: false });
  } finally { await stack.stop(); }
}, 180_000);
