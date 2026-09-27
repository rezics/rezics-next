import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../src/modules/work/select-main.ts';
import { GRAPHS, RV, iri } from '../src/modules/work/activate.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('Reader: public and private composition pages, current Content, cursor and revision fences', async () => {
  const stack = await startMediaStack('work-contents');
  try {
    const a = await stack.member('contents-owner');
    const b = await stack.member('contents-stranger');
    const bookTitle = `Reader Book ${randomUUID()}`;
    const created = await activateMetadataWork(stack.env, { title: bookTitle,
      semanticTypes: ['https://schema.org/Book'],
      admission: stack.admission(a.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(bookTitle, ['https://schema.org/Book'])) });
    if (!created.work || !created.mainVersion) throw new Error('Book was not created');
    const book = { work: created.work, mainVersion: created.mainVersion };
    const contribution = await stack.contribution(book.work, a.actor, 'en', 'Public Book text');
    const selected = { context: { kind: 'main-version-default' as const, id: book.mainVersion },
      work: book.work, contribution: contribution.contribution, publicationDecision: contribution.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: a.actor };
    await selectMainDefault(stack.env, stack.admission(a.actor, `publication:select:${book.mainVersion}`,
      'publication.select', mainSelectionDigest(selected)), selected);
    // A public Post can be chapter Content without a separate Main selection.
    const chapterTarget = await stack.privateWork(a.actor, 'Reader chapter target');
    const hiddenTarget = await stack.privateWork(a.actor, 'Unpublished chapter target');
    await a.grant(`work:edit:${book.work}`, 'work.edit');
    await a.grant(`work:read:${book.work}`, 'work.read');
    await a.grant(`work:read:${chapterTarget.work}`, 'work.read');
    await a.grant(`work:read:${hiddenTarget.work}`, 'work.read');
    await a.grant(`content:draft:${chapterTarget.work}`, 'content.draft');
    const variant = `urn:rezics:variant:${randomUUID()}`;
    await a.grant(`content:publish:${variant}`, 'content.publish');
    await a.grant(`content:search-eligibility:${variant}`, 'content.search-eligibility');
    const store = stack.objects('semantic/structure/');
    await store.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof store }).structureObjects = store;
    const saved = await json<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(await a.send('POST',
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: chapterTarget.work,
        variantId: variant, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr', expectedHead: null, body: 'Exact reader body', actingSubject: a.actor }), 201);
    const exact = (await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Content draft was not saved');
    const published = await json<{ decision: string }>(await a.send('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `reader-${randomUUID()}`,
      revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
      expectedContentEpoch: saved.sourcePosition.dataEpoch, resourceId: chapterTarget.work,
      variantId: variant, expectedPublicationHead: null, actingSubject: a.actor }), 201);
    await json(await a.send('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: chapterTarget.work,
      variantId: variant, publicationDecision: published.decision,
      expectedEligibilityHead: null, actingSubject: a.actor,
      rightsBasis: 'original-contribution', disclosure: 'public' }), 201);
    const made = await json<{ structure: string; revision: string }>(await a.send('POST', '/v1/compositions',
      { profile: 'book-composition', work: book.work, mainVersion: book.mainVersion,
        actingSubject: a.actor }), 201);
    const changed = await json<{ revision: string; occurrences: string[] }>(await a.send('POST',
      `/v1/compositions/${short(made.structure)}/changes`, { profile: 'book-composition',
        expectedHead: made.revision, actingSubject: a.actor, operations: [
          { op: 'insert', parent: made.structure, position: 'last', role: 'chapter',
            target: chapterTarget.work, label: { value: 'Chapter one', language: 'en' } },
          { op: 'insert', parent: made.structure, position: 'last', role: 'chapter',
            target: chapterTarget.work, label: { value: 'Chapter two', language: 'en' } },
          { op: 'insert', parent: made.structure, position: 'last', role: 'chapter',
            target: hiddenTarget.work, label: { value: 'Hidden chapter', language: 'en' } },
        ] }), 200);
    const root = `/v1/works/${short(book.work)}/contents`;
    const get = (path: string) => stack.call('GET', path);
    const beforePage = stack.fuseki.queries;
    const first = await json<{ items: Array<{ occurrence: string; availability: string; target: string | null }>;
      nextCursor: string; version: string; compositionRevision: string }>(await get(`${root}?limit=1`));
    expect(stack.fuseki.queries - beforePage).toBeLessThanOrEqual(64);
    expect(first).toMatchObject({ version: book.mainVersion, compositionRevision: changed.revision,
      items: [{ occurrence: changed.occurrences[0], availability: 'available', target: chapterTarget.work }] });
    const second = await json<{ items: Array<{ availability: string; target: string | null }>;
      nextCursor: string }>(await get(`${root}?limit=1&cursor=${first.nextCursor}`));
    expect(second.items).toMatchObject([{ availability: 'available', target: chapterTarget.work }]);
    const third = await json<{ items: Array<{ availability: string; target: string | null }>;
      nextCursor: null }>(await get(`${root}?limit=1&cursor=${second.nextCursor}`));
    expect(third.items).toMatchObject([{ availability: 'unavailable', target: null }]);
    expect(third.nextCursor).toBeNull();
    expect((await get(`${root}?language=ja&cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await get(`${root}?version=https://rezics.com/id/${randomUUID()}`)).status).toBe(404);
    expect((await get(`/v1/works/${randomUUID()}/contents`)).status).toBe(404);
    expect((await get(`${root}?limit=21`)).status).toBe(400);
    expect((await get(`${root}?actingSubject=${encodeURIComponent(a.actor)}`)).status).toBe(401);
    expect((await get(`${root}?language=ja`)).status).toBe(200);
    expect((await b.read(`${root}?actingSubject=${encodeURIComponent(b.actor)}`)).status).toBe(200);
    const chapterPath = `/v1/chapters/${short(changed.occurrences[0]!)}`;
    const beforeChapter = stack.fuseki.queries;
    const chapter = await json<{ content: { body: { body: string } }; selectedRevision: string;
      progress: { composition: string; occurrence: string; selectedRevision: string };
      previous: string | null; next: string | null }>(await get(chapterPath));
    expect(stack.fuseki.queries - beforeChapter).toBeLessThanOrEqual(64);
    expect(chapter.content.body.body).toBe('Exact reader body');
    expect(chapter.selectedRevision).toBe(`urn:rezics:content:revision:${saved.revisionId}`);
    expect(chapter.progress).toEqual({ composition: made.structure,
      occurrence: changed.occurrences[0], selectedRevision: chapter.selectedRevision });
    expect(chapter.previous).toBeNull();
    expect(chapter.next).toBe(changed.occurrences[1]);
    const secondChapter = await json<{ previous: string | null; next: string | null }>(await get(
      `/v1/chapters/${short(changed.occurrences[1]!)}`));
    expect(secondChapter.previous).toBe(changed.occurrences[0]);
    expect(secondChapter.next).toBeNull();
    expect((await get(`${chapterPath}?language=ja`)).status).toBe(404);
    expect((await get(`${chapterPath}?revision=${encodeURIComponent(made.revision)}`)).status).toBe(409);
    expect((await get(`/v1/chapters/${short(changed.occurrences[2]!)}`)).status).toBe(404);
    expect((await get(`/v1/chapters/${randomUUID()}`)).status).toBe(404);
    const privateTitle = `Private Reader Book ${randomUUID()}`;
    const privateBook = await activateMetadataWork(stack.env, { title: privateTitle,
      semanticTypes: ['https://schema.org/Book'],
      admission: stack.admission(a.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(privateTitle, ['https://schema.org/Book'])) });
    if (!privateBook.work || !privateBook.mainVersion) throw new Error('Private Book was not created');
    await a.grant(`work:edit:${privateBook.work}`, 'work.edit');
    await a.grant(`work:read:${privateBook.work}`, 'work.read');
    await json(await a.send('POST', '/v1/compositions', { profile: 'book-composition',
      work: privateBook.work, mainVersion: privateBook.mainVersion, actingSubject: a.actor }), 201);
    const privatePath = `/v1/works/${short(privateBook.work)}/contents`;
    expect((await get(privatePath)).status).toBe(404);
    expect((await b.read(`${privatePath}?actingSubject=${encodeURIComponent(b.actor)}`)).status).toBe(404);
    expect((await a.read(`${privatePath}?actingSubject=${encodeURIComponent(a.actor)}&language=en`)).status).toBe(200);
    const moved = await json<{ revision: string }>(await a.send('POST',
      `/v1/compositions/${short(made.structure)}/changes`, { profile: 'book-composition',
        expectedHead: changed.revision, actingSubject: a.actor,
        operations: [{ op: 'insert', parent: made.structure, position: 'last', role: 'group',
          label: { value: 'After cursor', language: 'en' } }] }), 200);
    expect(moved.revision).not.toBe(changed.revision);
    expect((await get(`${root}?limit=1&cursor=${first.nextCursor}`)).status).toBe(409);
    expect((await get(`${chapterPath}?revision=${encodeURIComponent(changed.revision)}`)).status).toBe(409);
    await stack.contentPool.query(`UPDATE content.revision SET availability = 'unavailable',
      serialized_bytes = NULL, body = NULL WHERE id = $1`, [saved.revisionId]);
    expect((await get(chapterPath)).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(chapter.selectedRevision)} a rv:ErasedRevision . } }`);
    expect((await get(chapterPath)).status).toBe(404);
    const afterErasure = await json<{ items: Array<{ availability: string; target: string | null }> }>(
      await get(`${root}?limit=1`));
    expect(afterErasure.items).toMatchObject([{ availability: 'unavailable', target: null }]);
  } finally { await stack.stop(); }
}, 180_000);
