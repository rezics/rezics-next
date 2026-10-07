import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool, type QueryResult } from 'pg';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { StructureGroupRootStore } from '../src/modules/structure/group-root.ts';
import { StructureQualifierRootStore } from '../src/modules/structure/qualifier-index.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { checkStructureManifest, checkStructurePage, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT,
  STRUCTURE_PROFILE, type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { readCompositionPage, readCompositionSnapshot } from '../src/modules/structure/read.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { chapterStoryNumber } from '../src/modules/work-contents/read.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import { assertObjectRecoveryCoverage, captureObjectRecoveryCoverage } from '../src/modules/owner/object-coverage.ts';
import { OwnerOperations, OwnerOperationUnavailable } from '../src/modules/owner/operations.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { upgradeStoredMembership } from '../src/modules/structure/membership-normalize.ts';
import { createMainApp } from '../src/app.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { StructureProgressStore } from '../src/modules/progress/store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../src/modules/work/select-main.ts';
import { DATASET, GRAPHS, ID, RV, iri, lit } from '../src/modules/work/activate.ts';

const short = (id: string) => id.slice(-36);
// Direct-app fixtures bypass Main's explicit storage preparation entrypoint.
// Run it at fixture startup, never as a chapter request or ordinary mutation.
async function preparedReaderStack(label: string) {
  const stack = await startMediaStack(label);
  try { await upgradeStoredMembership(stack.env); return stack; }
  catch (error) { await stack.stop(); throw error; }
}
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('Reader: public and private composition pages, current Content, cursor and revision fences', async () => {
  const stack = await preparedReaderStack('work-contents');
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
    await a.grant(`content:publish:${chapterTarget.work}`, 'content.publish');
    await a.grant(`content:search-eligibility:${chapterTarget.work}`, 'content.search-eligibility');
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
    await stack.privateWork(a.actor, 'Unrelated contents cursor growth');
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
      previous: string | null; next: string | null; label: { value: string; language: string };
      ordinal: number; parentPath: unknown[] }>(await get(chapterPath));
    expect(stack.fuseki.queries - beforeChapter).toBeLessThanOrEqual(64);
    expect(chapter.content.body.body).toBe('Exact reader body');
    expect(chapter.selectedRevision).toBe(`urn:rezics:content:revision:${saved.revisionId}`);
    expect(chapter.progress).toEqual({ composition: made.structure,
      occurrence: changed.occurrences[0], selectedRevision: chapter.selectedRevision });
    expect(chapter.previous).toBeNull();
    expect(chapter.next).toBe(changed.occurrences[1]);
    expect(chapter.label).toEqual({ value: 'Chapter one', language: 'en' });
    expect(chapter.ordinal).toBe(1);
    expect(chapter.parentPath).toEqual([]);
    const secondChapter = await json<{ previous: string | null; next: string | null;
      ordinal: number; label: { value: string } }>(await get(
      `/v1/chapters/${short(changed.occurrences[1]!)}`));
    expect(secondChapter.previous).toBe(changed.occurrences[0]);
    expect(secondChapter.next).toBeNull();
    expect(secondChapter.ordinal).toBe(2);
    expect(secondChapter.label.value).toBe('Chapter two');
    let privateReadActive = true;
    // Progress reads also disclose the placed Work's own summary. Public
    // Content eligibility alone does not publish that Work's Main selection.
    await b.grant(`work:read:${chapterTarget.work}`, 'work.read');
    const progressApp = createMainApp(stack.fuseki, { environment: stack.env,
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.slice(7);
        if (token === a.token) return { ...a.principal, emailVerified: true };
        if (token === b.token) return { ...b.principal, emailVerified: true };
        throw new Error('unknown bearer');
      } },
      access: { assertRecoveryOpen: stack.access.assertRecoveryOpen.bind(stack.access),
        canReadWork: async (principal: VerifiedPrincipal, actor: string, target: string) => privateReadActive
          && stack.access.canReadWork(principal, actor, target),
        activePrincipalId: stack.access.activePrincipalId.bind(stack.access),
        canReadAsBaselineMember: async (principal: VerifiedPrincipal, actor: string) => privateReadActive
          && principal.subject === b.principal.subject && actor === b.actor } as never,
      progress: new StructureProgressStore(stack.contentPool) });
    const progressPath = `/v1/compositions/${short(made.structure)}/occurrences/${short(changed.occurrences[0]!)}/progress`;
    const progressCall = (method: string, token: string, actor: string, body?: object, key?: string) =>
      progressApp.handle(new Request(`http://main.local${progressPath}${method === 'GET'
        ? `?actingSubject=${encodeURIComponent(actor)}&selectedRevision=${encodeURIComponent(chapter.selectedRevision)}` : ''}`,
      { method, headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key ?? randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const empty = await json<{ version: number }>(await progressCall('GET', b.token, b.actor));
    expect(empty.version).toBe(0);
    const savedProgress = await json<{ completed: boolean; version: number }>(await progressCall('PUT',
      b.token, b.actor, { actingSubject: b.actor, selectedRevision: chapter.selectedRevision,
        expectedVersion: 0, completed: true, position: null }));
    expect(savedProgress).toMatchObject({ completed: true, version: 1 });
    privateReadActive = false;
    expect((await progressCall('GET', b.token, b.actor)).status).toBe(404);
    privateReadActive = true;
    expect((await progressCall('GET', b.token, a.actor)).status).toBe(404);
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

test('Reader: chapter Posts and independently maintained anthology Works retain their own identities', async () => {
  const stack = await preparedReaderStack('chapter-place');
  try {
    const a = await stack.member('chapter-place-owner');
    const store = stack.objects('semantic/structure/');
    await store.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof store }).structureObjects = store;
    const composed = async (title: string) => {
      const types = ['https://schema.org/Book'];
      const created = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
        a.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
      if (!created.work || !created.mainVersion) throw new Error('Book was not created');
      const book = { work: created.work, mainVersion: created.mainVersion };
      const text = await stack.contribution(book.work, a.actor, 'en', `${title} text`);
      const selection = { context: { kind: 'main-version-default' as const, id: book.mainVersion }, work: book.work,
        contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: a.actor };
      await selectMainDefault(stack.env, stack.admission(a.actor, `publication:select:${book.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await a.grant(`work:edit:${book.work}`, 'work.edit');
      await a.grant(`work:read:${book.work}`, 'work.read');
      const made = await json<{ structure: string; revision: string }>(await a.send('POST', '/v1/compositions',
        { profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: a.actor }), 201);
      return { ...book, ...made };
    };
    const book = await composed(`Chapter place book ${randomUUID()}`);
    const other = await composed(`Chapter place anthology ${randomUUID()}`);
    // A Post is placed beside independent Works; placement does not turn those Works into Posts.
    const made = await json<{ post: string; occurrence: string; compositionRevision: string }>(await a.send('POST',
      `/v1/works/${short(book.work)}/chapters`, { profile: 'book-chapter-create-v1', title: 'Chapter one',
        language: 'en', direction: 'ltr', parent: book.structure, position: 'last',
        expectedCompositionHead: book.revision, actingSubject: a.actor }), 200);
    const legacy = await stack.privateWork(a.actor, 'Placed chapter');
    const twice = await stack.privateWork(a.actor, 'Chapter in two Books');
    for (const target of [made.post, legacy.work, twice.work]) await a.grant(`work:read:${target}`, 'work.read');
    const placed = await json<{ revision: string; occurrences: string[] }>(await a.send('POST',
      `/v1/compositions/${short(book.structure)}/changes`, { profile: 'book-composition',
        expectedHead: made.compositionRevision, actingSubject: a.actor, operations: [
          { op: 'insert', parent: book.structure, position: 'last', role: 'chapter', target: legacy.work },
          { op: 'insert', parent: book.structure, position: 'last', role: 'chapter', target: twice.work }] }), 200);
    await json(await a.send('POST', `/v1/compositions/${short(other.structure)}/changes`, {
      profile: 'book-composition', expectedHead: other.revision, actingSubject: a.actor,
      operations: [{ op: 'insert', parent: other.structure, position: 'last', role: 'chapter',
        target: twice.work }] }), 200);
    const header = async (work: string) => json<{ partOf?: { work: string; occurrence: string | null } }>(
      await a.read(`/v1/works/${short(work)}?actingSubject=${encodeURIComponent(a.actor)}`));
    expect((await a.read(`/v1/works/${short(made.post)}?actingSubject=${encodeURIComponent(a.actor)}`)).status).toBe(404);
    expect((await header(legacy.work)).partOf).toBeUndefined();
    expect((await header(twice.work)).partOf).toBeUndefined();
    expect((await header(book.work)).partOf).toBeUndefined();
    // Removing an occurrence never deletes the Post.
    await json(await a.send('POST', `/v1/compositions/${short(book.structure)}/changes`, {
      profile: 'book-composition', expectedHead: placed.revision, actingSubject: a.actor,
      operations: [{ op: 'remove', occurrence: made.occurrence }] }), 200);
    expect(await json(await a.read(`/v1/posts/${short(made.post)}?actingSubject=${encodeURIComponent(a.actor)}`)))
      .toMatchObject({ id: made.post });
    const publicHeader = await json<{ partOf?: unknown }>(await stack.call('GET', `/v1/works/${short(book.work)}`));
    expect(publicHeader.partOf).toBeUndefined();
  } finally { await stack.stop(); }
}, 180_000);

test('Structure group order: admitted deltas, historical roots, restoration and durable staging', async () => {
  const { readCompositionSnapshot } = await import('../src/modules/structure/read.ts');
  const { orderTree, recordTree } = await import('../src/modules/structure/change.ts');
  const { checkStructureManifest } = await import('../src/modules/structure/format.ts');
  const { StructureStageStore } = await import('../src/modules/structure/stage.ts');
  const { newCost } = await import('../src/modules/structure/tree.ts');
  const stack = await preparedReaderStack('structure-group-order');
  try {
    const owner = await stack.member('structure-group-order-owner');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof objects }).structureObjects = objects;
    const title = `Group order lifecycle ${randomUUID()}`;
    const types = ['https://schema.org/Book'];
    const book = await activateMetadataWork(stack.env, { title, semanticTypes: types,
      admission: stack.admission(owner.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(title, types)) });
    if (!book.work || !book.mainVersion) throw new Error('Book was not created');
    await owner.grant(`work:edit:${book.work}`, 'work.edit');
    await owner.grant(`work:read:${book.work}`, 'work.read');
    const target = await stack.privateWork(owner.actor, 'Group order chapter target');
    await owner.grant(`work:read:${target.work}`, 'work.read');
    const created = await json<{ structure: string; revision: string }>(await owner.send('POST',
      '/v1/compositions', { profile: 'book-composition', work: book.work,
        mainVersion: book.mainVersion, actingSubject: owner.actor }), 201);
    const structure = created.structure;
    const snapshot = (revision?: string) => readCompositionSnapshot(stack.env, {
      structure, ...(revision ? { revision } : {}) });
    const groups = async (read: Awaited<ReturnType<typeof snapshot>>) => {
      const root = read.manifest.topGroups;
      if (!root) throw new Error('Book manifest has no retained group order root');
      const entries = await orderTree(read.objects).range(root, `${structure}\u0001`,
        `${structure}\u0002`, 201, read.cost);
      expect(entries).toHaveLength(root.count);
      return entries.map(entry => entry.occurrence);
    };
    expect(await groups(await snapshot())).toEqual([]);
    let head = created.revision;
    const change = async (operations: object[]) => {
      const result = await json<{ revision: string; occurrences: string[] }>(await owner.send('POST',
        `/v1/compositions/${short(structure)}/changes`, { profile: 'book-composition',
          expectedHead: head, actingSubject: owner.actor, operations }), 200);
      head = result.revision;
      return result;
    };
    const inserted = await change([
      { op: 'insert', parent: structure, position: 'last', role: 'group', division: 'volume',
        label: { value: 'First volume', language: 'en' } },
      { op: 'insert', parent: structure, position: 'last', role: 'chapter', target: target.work },
      { op: 'insert', parent: structure, position: 'last', role: 'chapter', target: target.work },
      { op: 'insert', parent: structure, position: 'last', role: 'group', division: 'extras',
        label: { value: 'Empty extras', language: 'en' } },
    ]);
    const volume = inserted.occurrences[0]!;
    const empty = inserted.occurrences[3]!;
    expect(await groups(await snapshot())).toEqual([volume, empty]);
    const child = await change([{ op: 'insert', parent: volume, position: 'last', role: 'chapter',
      target: target.work, label: { value: 'Grouped chapter', language: 'en' } }]);
    const historicalRevision = head;
    const historical = await snapshot(historicalRevision);
    const historicalManifestDigest = historical.header.manifest.slice(-64);
    const historicalBytes = await objects.get(historicalManifestDigest);
    const historicalGroupRoot = historical.manifest.topGroups;
    expect(await groups(historical)).toEqual([volume, empty]);
    await change([{ op: 'move', occurrence: volume, parent: structure, position: 'last' }]);
    const moved = await snapshot();
    expect(await groups(moved)).toEqual([empty, volume]);
    const rootOrder = await orderTree(objects).range(moved.manifest.order,
      `${structure}\u0001`, `${structure}\u0002`, 10, moved.cost);
    expect(rootOrder.map(entry => entry.occurrence)).toEqual([
      inserted.occurrences[1], inserted.occurrences[2], empty, volume,
    ]);
    await change([{ op: 'remove', occurrence: empty }]);
    expect(await groups(await snapshot())).toEqual([volume]);
    await change([{ op: 'remove', occurrence: child.occurrences[0]! }]);
    await change([{ op: 'remove', occurrence: volume }]);
    expect(await groups(await snapshot())).toEqual([]);
    // Reopening the exact root after later mutations models a reader restart:
    // no request-local cache or today's placements can supply its group order.
    const reopened = await snapshot(historicalRevision);
    expect(await groups(reopened)).toEqual([volume, empty]);
    expect(reopened.manifest.topGroups).toEqual(historicalGroupRoot);
    expect(await objects.get(historicalManifestDigest)).toEqual(historicalBytes);
    const restored = await json<{ revision: string }>(await owner.send('POST',
      `/v1/compositions/${short(structure)}/restorations`, { expectedHead: head,
        restoredFrom: historicalRevision, actingSubject: owner.actor }), 200);
    head = restored.revision;
    const restoredSnapshot = await snapshot();
    expect(restoredSnapshot.revision).toBe(head);
    expect(restoredSnapshot.revision).not.toBe(historicalRevision);
    expect(restoredSnapshot.header.manifest.slice(-64)).not.toBe(historicalManifestDigest);
    expect(restoredSnapshot.manifest.restoredFrom).toBe(historicalRevision);
    expect(restoredSnapshot.manifest.placementCount).toBe(historical.manifest.placementCount);
    expect(restoredSnapshot.manifest.topGroups).toEqual(historicalGroupRoot);
    expect(await groups(restoredSnapshot)).toEqual([volume, empty]);
    expect(await objects.get(historicalManifestDigest)).toEqual(historicalBytes);

    const principalId = randomUUID();
    const stages = new StructureStageStore(stack.contentPool, objects);
    let stage = await stages.create({ principalId, idempotencyKey: `groups:${randomUUID()}`,
      scope: `work:edit:${book.work}`, structure, baseHead: head });
    const records = await recordTree(objects).range(restoredSnapshot.manifest.records,
      '', '\uffff', 20, newCost());
    expect(records).toHaveLength(restoredSnapshot.manifest.records.count);
    stage = await stages.upload({ id: stage.id, principalId, structure,
      holder: stage.holder!, fence: stage.fence, ordinal: 0, entries: records });
    const resumedStages = new StructureStageStore(stack.contentPool, stack.objects('semantic/structure/'));
    // A retry after upload acknowledgement loss resumes the same durable page.
    stage = await resumedStages.upload({ id: stage.id, principalId, structure,
      holder: stage.holder!, fence: stage.fence, ordinal: 0, entries: records });
    expect(stage.pages).toBe(1);
    stage = await resumedStages.seal({ id: stage.id, principalId, structure,
      mainVersion: book.mainVersion, holder: stage.holder!, fence: stage.fence,
      canReadTarget: async resource => resource === target.work });
    expect(stage.status).toBe('sealed');
    if (!stage.manifest) throw new Error('Stage manifest was not persisted');
    const stageBytes = await objects.get(stage.manifest);
    const stageManifest = checkStructureManifest(stageBytes);
    expect(stageManifest.topGroups?.count).toBe(2);
    if (!stageManifest.topGroups) throw new Error('Stage has no retained group order root');
    const stagedGroups = await orderTree(objects).range(stageManifest.topGroups,
      `${structure}\u0001`, `${structure}\u0002`, 10, newCost());
    expect(stagedGroups.map(entry => entry.occurrence)).toEqual([volume, empty]);
    const restartedStages = new StructureStageStore(stack.contentPool, stack.objects('semantic/structure/'));
    const persisted = await restartedStages.read(stage.id, principalId, structure);
    expect(persisted).toMatchObject({ status: 'sealed', manifest: stage.manifest, pages: 1,
      placementCount: restoredSnapshot.manifest.placementCount });
    expect(await objects.get(persisted.manifest!)).toEqual(stageBytes);
    expect((await restartedStages.seal({ id: stage.id, principalId, structure,
      mainVersion: book.mainVersion, holder: stage.holder!, fence: stage.fence,
      canReadTarget: async () => { throw new Error('sealed retry must reuse the original root'); } })).manifest)
      .toBe(stage.manifest);
    await restartedStages.cancel(stage.id, principalId, structure);
  } finally { await stack.stop(); }
}, 180_000);

/** Observe actual verified S3 GETs, including read-backs performed by put. */
function observeLegacyObjects<T extends ImmutableObjects>(objects: T) {
  const get = objects.get.bind(objects), put = objects.put.bind(objects);
  const cost = { gets: 0, bytes: 0, puts: 0 };
  objects.get = async digest => {
    const bytes = await get(digest);
    cost.gets++;
    cost.bytes += bytes.length;
    return bytes;
  };
  objects.put = async bytes => { cost.puts++; return put(bytes); };
  return { objects, cost, reset: () => { cost.gets = 0; cost.bytes = 0; cost.puts = 0; } };
}

/** The store uses autocommit pool queries. Delegate to the real owner pool so
 * race/acknowledgement faults occur around committed PostgreSQL results. */
function checkpointPool(pool: Pool, around: (sql: string, values: unknown[] | undefined,
  execute: () => Promise<QueryResult>) => Promise<QueryResult>): Pool {
  const wrapped: Pool = Object.create(pool);
  Object.defineProperty(wrapped, 'query', { value: (sql: string, values?: unknown[]) =>
    around(sql, values, () => pool.query(sql, values)) });
  return wrapped;
}

async function legacySparseBook(stack: Awaited<ReturnType<typeof startMediaStack>>, objects: ImmutableObjects,
  chapterCount = 10_000) {
  const salt = randomUUID().slice(0, 8);
  const id = (at: number) => `${ID}${salt}-0000-4000-8000-${at.toString(16).padStart(12, '0')}`;
  const structure = id(1), component = id(2), owner = id(3), revision = id(4), generation = id(5);
  const records: OccurrenceRecord[] = [], direct: OccurrenceRecord[] = [], groups: OccurrenceRecord[] = [];
  let identity = 100, sibling = 0;
  const record = (parent: string, index: number, role: 'chapter' | 'group',
    division?: 'volume' | 'part' | 'extras'): OccurrenceRecord => {
    const value: OccurrenceRecord = { occurrence: id(identity++), state: 'active', parent, role,
      segmentKey: Math.floor(index / 32).toString(36).padStart(6, '0'),
      orderKey: (index % 32).toString(36).padStart(2, '0'), introducedBy: revision,
      labels: [{ value: role === 'chapter' ? 'Legacy chapter' : 'Legacy group', language: 'en' }],
      ...(role === 'chapter' ? { target: id(100_000 + identity), selection: { mode: 'follow-context' as const } }
        : { qualifier: { type: 'book-group' as const, division: division! } }) };
    records.push(value);
    return value;
  };
  for (let at = 0; at < chapterCount; at++) {
    const division = at === 100 ? 'volume' : at === 5_000 ? 'extras' : at === 9_900 ? 'part' : null;
    if (division) {
      const group = record(structure, sibling++, 'group', division);
      groups.push(group);
      record(group.occurrence, 0, 'chapter');
    }
    direct.push(record(structure, sibling++, 'chapter'));
  }
  const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
  const recordRoot = await recordIndex.apply(await recordIndex.empty(cost),
    new Map(records.map(value => [value.occurrence, value])), cost);
  const entries: OrderEntry[] = records.map(value => ({ parent: value.parent,
    occurrence: value.occurrence, segmentKey: value.segmentKey!, orderKey: value.orderKey! }));
  const orderRoot = await orderIndex.apply(await orderIndex.empty(cost),
    new Map(entries.map(value => [orderTreeKey(value), value])), cost);
  // These are newly authored legacy fixture bytes. No existing revision's
  // manifest or object is rewritten to manufacture the preparation scenario.
  const source: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: component,
    profile: 'book-composition', generation, pageFormat: STRUCTURE_PAGE_FORMAT, records: recordRoot,
    order: orderRoot, placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  checkStructureManifest(bytes);
  const digest = await objects.put(bytes);
  await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(structure)} a rv:Structure ; rv:structureProfile rv:BookComposition ; rv:structureOf ${iri(component)} ;
        rv:structureHead ${iri(revision)} ; rv:selectedGeneration ${iri(generation)} .
      ${iri(generation)} a rv:StructureGeneration ; rv:structure ${iri(structure)} ;
        rv:generationState rv:Active ; rv:placementCount ${source.placementCount} .
      ${iri(owner)} a <https://schema.org/Book> ; rv:mainVersion ${iri(component)} .
      ${iri(component)} a rv:MainVersion .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(revision)} a rv:StructureRevision ; rv:component ${iri(structure)} ;
        rv:manifest <urn:rezics:sha256:${digest}> ; rv:placementCount ${source.placementCount} ;
        rv:modelRevision <${STRUCTURE_PROFILE}> ; rv:shapeRevision <${STRUCTURE_PROFILE}> ;
        rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ; rv:sequence 1 .
    }
  }`);
  return { structure, revision, source, digest, bytes, direct, groups };
}

test('Legacy group preparation: bounded durable batches, restart, CAS, lost acknowledgement and protected exact source', async () => {
  const preparation = performance.now(), stack = await startMediaStack('legacy-group-preparation');
  try {
    const observed = observeLegacyObjects(stack.objects('semantic/structure/'));
    const objects = observed.objects;
    await objects.initialize();
    const legacy = await legacySparseBook(stack, objects);
    expect(performance.now() - preparation).toBeLessThan(600_000);
    const store = new StructureGroupRootStore(stack.contentPool, objects);
    stack.env.structureGroupRoots = store;
    stack.env.structureQualifierRoots = new StructureQualifierRootStore(stack.contentPool, objects);
    (stack.env as typeof stack.env & { structureObjects: typeof objects }).structureObjects = objects;
    expect(await store.read(legacy.digest)).toBeNull();
    expect(await store.completedTopGroups(legacy.digest, legacy.source)).toBeNull();
    const pending = await readCompositionSnapshot(stack.env, { structure: legacy.structure });
    const session = () => new WorkReadSession({ environment: stack.env } as MainWorkDependencies,
      new Request('http://main.local/v1/chapters'), {}, { dataEpoch: stack.env.lineage.dataEpoch, sequence: '1' });
    await expect(chapterStoryNumber(session(), pending.header, legacy.direct[0]!,
      { ordinal: 1, path: [] }, pending)).rejects.toThrow(/group|prepar|unavailable/iu);

    let deadlineChecks = 0;
    let beforeGraph = stack.fuseki.queries;
    observed.reset();
    const beforeSql = stack.contentPool.checkouts;
    let checkpoint = await store.prepare(legacy.digest, { checkDeadline: () => { deadlineChecks++; } });
    expect(deadlineChecks).toBeGreaterThan(0);
    expect(checkpoint).toMatchObject({ manifestDigest: legacy.digest, structure: legacy.structure,
      records: legacy.source.records, order: legacy.source.order, total: 10_003, scanned: 256, complete: false });
    expect(checkpoint.groups.count).toBe(1);
    expect(checkpoint.cursor).toBe(orderTreeKey(legacy.direct[254]! as OrderEntry));
    expect(observed.cost.gets).toBeLessThanOrEqual(32);
    expect(observed.cost.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(stack.contentPool.checkouts - beforeSql).toBeLessThanOrEqual(6);
    expect(stack.fuseki.queries).toBe(beforeGraph);
    expect(await store.completedTopGroups(legacy.digest, legacy.source)).toBeNull();
    const nextEntry = (await orderTree(objects).range(legacy.source.order, `${checkpoint.cursor}\u0000`,
      `${legacy.structure}\u0002`, 1, newCost()))[0]!;
    expect(nextEntry.occurrence).toBe(legacy.direct[255]!.occurrence);
    // One newly scanned placement cannot introduce two groups. The version,
    // cursor and scan delta are otherwise valid, so the owner guard decides it.
    await expect(stack.contentPool.query(`UPDATE structure.group_root
      SET version = version + 1, scanned = scanned + 1, cursor = $2, groups = $3
      WHERE manifest_digest = $1`, [legacy.digest, orderTreeKey(nextEntry),
      { ...checkpoint.groups, count: checkpoint.groups.count + 2 }]))
      .rejects.toThrow('group preparation checkpoint');
    expect(await store.read(legacy.digest)).toEqual(checkpoint);

    // Author a separate exact 256-entry source from the first immutable range.
    // It has its own SHA and never replaces an existing graph revision/object.
    const first256 = await orderTree(objects).range(legacy.source.order, `${legacy.structure}\u0001`,
      `${legacy.structure}\u0002`, 256, newCost());
    expect(first256).toHaveLength(256);
    const sourceRecords = await recordTree(objects).lookup(legacy.source.records,
      first256.map(entry => entry.occurrence), newCost());
    expect(sourceRecords.size).toBe(256);
    const boundedRecords = recordTree(objects), boundedOrder = orderTree(objects), boundedCost = newCost();
    const eofSource: StructureManifest = { ...legacy.source,
      records: await boundedRecords.apply(await boundedRecords.empty(boundedCost),
        new Map(first256.map(entry => [entry.occurrence, sourceRecords.get(entry.occurrence)!])), boundedCost),
      order: await boundedOrder.apply(await boundedOrder.empty(boundedCost),
        new Map(first256.map(entry => [orderTreeKey(entry), entry])), boundedCost),
      placementCount: 256 };
    const eofBytes = new TextEncoder().encode(JSON.stringify(eofSource));
    checkStructureManifest(eofBytes);
    const eofDigest = await objects.put(eofBytes);
    expect(eofDigest).not.toBe(legacy.digest);
    let insertAcknowledgementLost = false;
    const lostInsertPool = checkpointPool(stack.contentPool, async (sql, values, execute) => {
      const result = await execute();
      if (!insertAcknowledgementLost && /^INSERT INTO structure\.group_root/iu.test(sql.trim())
        && values?.[0] === eofDigest && result.rowCount === 1) {
        insertAcknowledgementLost = true;
        throw new Error('Fixture lost INSERT acknowledgement after PostgreSQL autocommit');
      }
      return result;
    });
    observed.reset();
    const eofCalls = stack.contentPool.checkouts;
    const eofPending = await new StructureGroupRootStore(lostInsertPool, objects).prepare(eofDigest);
    expect(insertAcknowledgementLost).toBe(true);
    expect(eofPending).toMatchObject({ manifestDigest: eofDigest, total: 256, scanned: 256, complete: false });
    expect(eofPending.groups.count).toBe(1);
    expect(eofPending.cursor).toBe(orderTreeKey(first256.at(-1)!));
    expect(observed.cost.gets).toBeLessThanOrEqual(32);
    expect(observed.cost.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(stack.contentPool.checkouts - eofCalls).toBeLessThanOrEqual(6);
    expect(stack.fuseki.queries).toBe(beforeGraph);
    expect(await store.completedTopGroups(eofDigest, eofSource)).toBeNull();
    expect(await store.read(eofDigest)).toEqual(eofPending);
    // An EOF completion has no new placements to justify a different root.
    await expect(stack.contentPool.query(`UPDATE structure.group_root
      SET complete = true, version = version + 1, groups = $2
      WHERE manifest_digest = $1`, [eofDigest,
      { ...eofPending.groups, page: `sha256:${'f'.repeat(64)}` }]))
      .rejects.toThrow('group preparation checkpoint');
    expect(await store.read(eofDigest)).toEqual(eofPending);
    observed.reset();
    const eofCompletionCalls = stack.contentPool.checkouts;
    const eofComplete = await new StructureGroupRootStore(stack.contentPool, objects).prepare(eofDigest);
    expect(eofComplete).toMatchObject({ scanned: 256, total: 256, complete: true,
      cursor: eofPending.cursor, groups: eofPending.groups });
    expect(BigInt(eofComplete.version)).toBe(BigInt(eofPending.version) + 1n);
    expect(observed.cost.gets).toBeLessThanOrEqual(32);
    expect(observed.cost.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(stack.contentPool.checkouts - eofCompletionCalls).toBeLessThanOrEqual(3);
    expect(stack.fuseki.queries).toBe(beforeGraph);
    expect(await store.completedTopGroups(eofDigest, eofSource)).toEqual(eofPending.groups);
    expect(await objects.get(eofDigest)).toEqual(eofBytes);
    expect(await objects.get(legacy.digest)).toEqual(legacy.bytes);
    expect(await store.read(legacy.digest)).toEqual(checkpoint);
    const protectedPartial = (await store.retainedRoots()).find(value => value.manifestDigest === legacy.digest);
    expect(protectedPartial).toEqual(checkpoint);
    expect(checkStructurePage(await objects.get(protectedPartial!.groups.page.slice(7))).tree).toBe('order');
    expect((await orderTree(objects).range(protectedPartial!.groups, `${legacy.structure}\u0001`,
      `${legacy.structure}\u0002`, 4, newCost())).map(value => value.occurrence)).toEqual([legacy.groups[0]!.occurrence]);
    expect(await objects.get(legacy.digest)).toEqual(legacy.bytes);
    const partialRead = await readCompositionSnapshot(stack.env, { structure: legacy.structure });
    expect(partialRead.manifest.topGroups).toBeUndefined();
    await expect(chapterStoryNumber(session(), partialRead.header, legacy.direct[0]!,
      { ordinal: 1, path: [] }, partialRead)).rejects.toThrow(/group|prepar|unavailable/iu);
    const coverageStore = { directory: stack.env.objectDirectory, structureObjects: objects, structureGroupRoots: store,
      structureQualifierRoots: stack.env.structureQualifierRoots };
    const pendingObjects = new Set<string>();
    const partialCoverage = await captureObjectRecoveryCoverage(stack.fuseki, coverageStore, pendingObjects);
    expect(pendingObjects.has(checkpoint.groups.page.slice(7))).toBe(true);
    expect(pendingObjects.has(legacy.digest)).toBe(true);
    expect(pendingObjects.has(legacy.source.records.page.slice(7))).toBe(true);
    expect(pendingObjects.has(legacy.source.order.page.slice(7))).toBe(true);
    await assertObjectRecoveryCoverage(stack.fuseki, coverageStore, partialCoverage);
    // Coverage is explicit maintenance; preparation itself must still perform
    // zero graph queries across every subsequent bounded turn.
    beforeGraph = stack.fuseki.queries;

    // Both contenders read the same committed version before either CAS runs.
    let readers = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const racingPool = checkpointPool(stack.contentPool, async (sql, values, execute) => {
      const result = await execute();
      if (/^SELECT\b/iu.test(sql.trim()) && /FROM structure\.group_root/iu.test(sql)
        && values?.[0] === legacy.digest && readers < 2) {
        if (++readers === 2) release();
        await barrier;
      }
      return result;
    });
    const results = await Promise.all([
      new StructureGroupRootStore(racingPool, objects).prepare(legacy.digest),
      new StructureGroupRootStore(racingPool, objects).prepare(legacy.digest),
    ]);
    expect(readers).toBe(2);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.scanned).toBe(checkpoint.scanned + 256);
    expect(BigInt(results[0]!.version)).toBe(BigInt(checkpoint.version) + 1n);
    checkpoint = results[0]!;

    let acknowledgementLost = false;
    const lostAckPool = checkpointPool(stack.contentPool, async (sql, _values, execute) => {
      const result = await execute();
      if (!acknowledgementLost && /^UPDATE structure\.group_root/iu.test(sql.trim()) && result.rowCount === 1) {
        acknowledgementLost = true;
        throw new Error('Fixture lost acknowledgement after PostgreSQL autocommit');
      }
      return result;
    });
    const afterLostAck = await new StructureGroupRootStore(lostAckPool, objects).prepare(legacy.digest);
    expect(acknowledgementLost).toBe(true);
    expect(afterLostAck.scanned).toBe(checkpoint.scanned + 256);
    expect(BigInt(afterLostAck.version)).toBe(BigInt(checkpoint.version) + 1n);
    expect(await store.read(legacy.digest)).toEqual(afterLostAck);
    checkpoint = afterLostAck;

    const resumed = new StructureGroupRootStore(stack.contentPool, stack.objects('semantic/structure/'));
    expect(await resumed.read(legacy.digest)).toEqual(checkpoint);
    let turns = 3;
    while (!checkpoint.complete) {
      const prior = checkpoint;
      observed.reset();
      const calls = stack.contentPool.checkouts;
      checkpoint = await new StructureGroupRootStore(stack.contentPool, objects).prepare(legacy.digest);
      turns++;
      expect(checkpoint.scanned - prior.scanned).toBeLessThanOrEqual(256);
      expect(checkpoint.scanned).toBeGreaterThanOrEqual(prior.scanned);
      expect(BigInt(checkpoint.version)).toBe(BigInt(prior.version) + 1n);
      expect(observed.cost.gets).toBeLessThanOrEqual(32);
      expect(observed.cost.bytes).toBeLessThan(2 * 1024 * 1024);
      expect(stack.contentPool.checkouts - calls).toBeLessThanOrEqual(3);
      expect(stack.fuseki.queries).toBe(beforeGraph);
      expect(turns).toBeLessThanOrEqual(41);
    }
    expect(turns).toBeGreaterThanOrEqual(40);
    expect(checkpoint.scanned).toBe(10_003);
    expect(checkpoint.groups.count).toBe(3);
    expect(await resumed.completedTopGroups(legacy.digest, legacy.source)).toEqual(checkpoint.groups);
    expect((await orderTree(objects).range(checkpoint.groups, `${legacy.structure}\u0001`,
      `${legacy.structure}\u0002`, 4, newCost())).map(value => value.occurrence))
      .toEqual(legacy.groups.map(value => value.occurrence));
    expect((await resumed.retainedRoots()).find(value => value.manifestDigest === legacy.digest)).toEqual(checkpoint);
    expect(await objects.get(legacy.digest)).toEqual(legacy.bytes);
    expect(checkStructureManifest(await objects.get(legacy.digest)).topGroups).toBeUndefined();
    const calls = stack.contentPool.checkouts;
    expect(await resumed.completedTopGroups(legacy.digest, legacy.source)).toEqual(checkpoint.groups);
    expect(stack.contentPool.checkouts - calls).toBe(1);
    await expect(resumed.completedTopGroups(legacy.digest, { ...legacy.source,
      order: { ...legacy.source.order, count: legacy.source.order.count - 1 } })).rejects.toThrow(/source/iu);
    // Source coordinates remain immutable at the durable owner boundary too.
    await expect(stack.contentPool.query(`UPDATE structure.group_root SET structure = $2
      WHERE manifest_digest = $1`, [legacy.digest, `${ID}${randomUUID()}`])).rejects.toThrow();
    expect(await resumed.read(legacy.digest)).toEqual(checkpoint);
    expect(await resumed.prepare(legacy.digest)).toEqual(checkpoint);
    const completedObjects = new Set<string>();
    const completedCoverage = await captureObjectRecoveryCoverage(stack.fuseki,
      { ...coverageStore, structureGroupRoots: resumed }, completedObjects);
    expect(completedObjects.has(checkpoint.groups.page.slice(7))).toBe(true);
    expect(completedObjects.has(legacy.digest)).toBe(true);
    expect(completedCoverage.referenceDigest).not.toBe(partialCoverage.referenceDigest);
    await assertObjectRecoveryCoverage(stack.fuseki, { ...coverageStore,
      structureGroupRoots: new StructureGroupRootStore(stack.contentPool, stack.objects('semantic/structure/')) }, completedCoverage);
    await expect(assertObjectRecoveryCoverage(stack.fuseki, coverageStore,
      { ...completedCoverage, referenceCount: '0' })).rejects.toThrow(/coverage/iu);

    stack.env.structureGroupRoots = resumed;
    const exact = await readCompositionSnapshot(stack.env, { structure: legacy.structure, revision: legacy.revision });
    expect(exact.manifest.topGroups).toEqual(checkpoint.groups);
    expect(exact.header.manifest).toBe(`urn:rezics:sha256:${legacy.digest}`);
    const last = legacy.direct.at(-1)!;
    const page = await readCompositionPage(stack.env, { structure: legacy.structure, snapshot: exact,
      occurrence: last.occurrence, limit: 1, canReadTarget: async () => true });
    expect(await chapterStoryNumber(session(), exact.header, last, page.occurrenceContext!, exact)).toBe(10_002);
    expect(await objects.get(legacy.digest)).toEqual(legacy.bytes);
  } finally { await stack.stop(); }
}, 180_000);

test('Legacy group preparation: authentic historical anchor resolves and a bounded admitted edit carries its prepared root', async () => {
  const stack = await preparedReaderStack('legacy-group-writer');
  try {
    const owner = await stack.member('legacy-group-writer-owner');
    const observed = observeLegacyObjects(stack.objects('semantic/structure/'));
    const objects = observed.objects;
    await objects.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof objects }).structureObjects = objects;
    const roots = new StructureGroupRootStore(stack.contentPool, objects);
    stack.env.structureGroupRoots = roots;
    const title = `Legacy writer Book ${randomUUID()}`, types = ['https://schema.org/Book'];
    const book = await activateMetadataWork(stack.env, { title, semanticTypes: types,
      admission: stack.admission(owner.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
    if (!book.work || !book.mainVersion) throw new Error('Book was not created');
    await owner.grant(`work:edit:${book.work}`, 'work.edit');
    await owner.grant(`work:read:${book.work}`, 'work.read');
    const target = await stack.privateWork(owner.actor, 'Legacy writer chapter target');
    await owner.grant(`work:read:${target.work}`, 'work.read');
    const created = await json<{ structure: string; revision: string }>(await owner.send('POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: owner.actor }), 201);
    const placed = await json<{ revision: string; occurrences: string[] }>(await owner.send('POST',
      `/v1/compositions/${short(created.structure)}/changes`, { profile: 'book-composition', expectedHead: created.revision,
        actingSubject: owner.actor, operations: [
          { op: 'insert', parent: created.structure, position: 'last', role: 'group', division: 'volume',
            label: { value: 'Legacy volume', language: 'en' } },
          { op: 'insert', parent: created.structure, position: 'last', role: 'chapter', target: target.work },
        ] }), 200);
    const child = await json<{ revision: string; occurrences: string[] }>(await owner.send('POST',
      `/v1/compositions/${short(created.structure)}/changes`, { profile: 'book-composition', expectedHead: placed.revision,
        actingSubject: owner.actor, operations: [{ op: 'insert', parent: placed.occurrences[0], position: 'last',
          role: 'chapter', target: target.work }] }), 200);
    const authored = await readCompositionSnapshot(stack.env, { structure: created.structure });
    const authoredDigest = authored.header.manifest.slice(-64), authoredBytes = await objects.get(authoredDigest);
    const { topGroups: _groups, ...legacyManifest } = authored.manifest;
    const legacyBytes = new TextEncoder().encode(JSON.stringify(legacyManifest));
    checkStructureManifest(legacyBytes);
    const legacyDigest = await objects.put(legacyBytes), legacyRevision = `${ID}${randomUUID()}`;
    // Add a separate legacy fixture revision using the admitted revision's
    // owner coordinates. Preserve every existing authored revision and object.
    await stack.fuseki.update(`PREFIX rv: <${RV}>
      INSERT { GRAPH ${iri(GRAPHS.revisions)} { ${iri(legacyRevision)} ?predicate ?value . } }
      WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(child.revision)} ?predicate ?value .
        FILTER(?predicate NOT IN (rv:manifest, rv:predecessor)) } };
      INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(legacyRevision)} rv:manifest <urn:rezics:sha256:${legacyDigest}> ; rv:predecessor ${iri(child.revision)} . } };
      DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(created.structure)} rv:structureHead ${iri(child.revision)} . } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(created.structure)} rv:structureHead ${iri(legacyRevision)} . } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(created.structure)} rv:structureHead ${iri(child.revision)} . } }`);
    // Raw retained-head fixture construction invalidates native membership
    // completion. Finish that explicit preparation before admitted edits.
    await upgradeStoredMembership(stack.env);
    expect((await readCompositionSnapshot(stack.env, { structure: created.structure })).manifest.topGroups).toBeUndefined();
    const complete = await roots.prepare(legacyDigest);
    expect(complete).toMatchObject({ complete: true, total: 2, scanned: 2 });
    expect(complete.groups.count).toBe(1);
    const restarted = new StructureGroupRootStore(stack.contentPool, stack.objects('semantic/structure/'));
    stack.env.structureGroupRoots = restarted;
    expect(await restarted.completedTopGroups(legacyDigest, legacyManifest)).toEqual(complete.groups);
    const historical = await readCompositionSnapshot(stack.env, { structure: created.structure, revision: legacyRevision });
    expect(historical.manifest.topGroups).toEqual(complete.groups);
    expect(historical.header.manifest).toBe(`urn:rezics:sha256:${legacyDigest}`);
    const exactChild = await readCompositionPage(stack.env, { structure: created.structure, snapshot: historical,
      occurrence: child.occurrences[0]!, limit: 1, canReadTarget: async () => true });
    const session = new WorkReadSession({ environment: stack.env } as MainWorkDependencies,
      new Request('http://main.local/v1/chapters'), {}, historical.sourcePosition);
    expect(await chapterStoryNumber(session, historical.header, exactChild.occurrences[0]!,
      exactChild.occurrenceContext!, historical)).toBe(1);
    observed.reset();
    const queries = stack.fuseki.queries;
    const changed = await json<{ revision: string; occurrences: string[] }>(await owner.send('POST',
      `/v1/compositions/${short(created.structure)}/changes`, { profile: 'book-composition', expectedHead: legacyRevision,
        actingSubject: owner.actor, operations: [{ op: 'insert', parent: created.structure, position: 'last',
          role: 'group', division: 'part', label: { value: 'After legacy preparation', language: 'en' } }] }), 200);
    expect(stack.fuseki.queries - queries).toBeLessThanOrEqual(64);
    expect(observed.cost.gets).toBeLessThanOrEqual(64);
    expect(observed.cost.bytes).toBeLessThan(2 * 1024 * 1024);
    const current = await readCompositionSnapshot(stack.env, { structure: created.structure });
    expect(current.revision).toBe(changed.revision);
    expect(current.manifest.topGroups?.count).toBe(2);
    expect((await orderTree(objects).range(current.manifest.topGroups!, `${created.structure}\u0001`,
      `${created.structure}\u0002`, 4, newCost())).map(value => value.occurrence))
      .toEqual([placed.occurrences[0], changed.occurrences[0]]);
    const retained = await readCompositionSnapshot(stack.env, { structure: created.structure, revision: legacyRevision });
    expect(retained.manifest.topGroups).toEqual(complete.groups);
    expect(retained.manifest.records).toEqual(legacyManifest.records);
    expect(await restarted.completedTopGroups(legacyDigest, legacyManifest)).toEqual(complete.groups);
    expect(await objects.get(legacyDigest)).toEqual(legacyBytes);
    expect(await objects.get(authoredDigest)).toEqual(authoredBytes);
  } finally { await stack.stop(); }
}, 180_000);

async function legacyQualifierStructure(objects: ImmutableObjects, count: number) {
  const salt = randomUUID().slice(0, 8);
  const id = (at: number) => `${ID}${salt}-0000-4000-8000-${at.toString(16).padStart(12, '0')}`;
  const structure = id(1), zone = id(2), revision = id(3);
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, at) => ({
    occurrence: id(100 + at), state: 'active', parent: structure, role: 'mount', target: id(100_000 + at),
    segmentKey: Math.floor(at / 32).toString(36).padStart(6, '0'), orderKey: (at % 32).toString(36).padStart(2, '0'),
    introducedBy: revision, labels: [], qualifier: { type: 'zone-mount', zone,
      routeSegment: `mount-${at}`, disclosure: 'public' },
  }));
  const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
  const entries: OrderEntry[] = records.map(record => ({ occurrence: record.occurrence,
    parent: record.parent, segmentKey: record.segmentKey!, orderKey: record.orderKey! }));
  const source: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: zone,
    profile: 'zone-navigation', generation: id(4), pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordIndex.apply(await recordIndex.empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost),
    order: await orderIndex.apply(await orderIndex.empty(cost),
      new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost),
    placementCount: count, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  checkStructureManifest(bytes);
  return { source, bytes, digest: await objects.put(bytes) };
}

test('Legacy Structure retention: OwnerOperations GC pins both checkpoint families and refuses missing custody', async () => {
  const stack = await startMediaStack('legacy-group-retention');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 2 });
  const missingDatabase = new URL(Bun.env.CONTENT_DATABASE_URL!);
  missingDatabase.pathname = `/group_roots_absent_${randomUUID().replaceAll('-', '')}`;
  const unavailableContent = new Pool({ connectionString: missingDatabase.toString(),
    max: 1, connectionTimeoutMillis: 1_000 });
  const missingBackendKey = `group-retention-unavailable-${randomUUID()}`;
  const missingQualifierBackendKey = `qualifier-retention-unavailable-${randomUUID()}`;
  let restoreHold: { type: string; value: string; datatype?: string } | undefined;
  let holdChanged = false;
  try {
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof objects }).structureObjects = objects;
    // The same real Content pool and S3 constructor pairing used by Main.
    stack.env.structureGroupRoots = new StructureGroupRootStore(stack.contentPool, objects);
    stack.env.structureQualifierRoots = new StructureQualifierRootStore(stack.contentPool, objects);
    const roots = stack.env.structureGroupRoots;
    const qualifierRoots = stack.env.structureQualifierRoots;
    const pendingSource = await legacySparseBook(stack, objects, 300);
    const completeSource = await legacySparseBook(stack, objects, 257);
    const pending = await roots.prepare(pendingSource.digest);
    expect(pending).toMatchObject({ total: 301, scanned: 256, complete: false });
    expect(pending.groups.count).toBe(1);
    const firstCompleteTurn = await roots.prepare(completeSource.digest);
    expect(firstCompleteTurn).toMatchObject({ total: 258, scanned: 256, complete: false });
    const complete = await roots.prepare(completeSource.digest);
    expect(complete).toMatchObject({ total: 258, scanned: 258, complete: true });
    expect(complete.groups.count).toBe(1);
    const pendingQualifierSource = await legacyQualifierStructure(objects, 300);
    const completedQualifierSource = await legacyQualifierStructure(objects, 257);
    const pendingQualifier = await qualifierRoots.prepare(pendingQualifierSource.digest);
    expect(pendingQualifier).toMatchObject({ complete: false, progress: { visited: 256, root: { count: 256 } } });
    const firstQualifierTurn = await qualifierRoots.prepare(completedQualifierSource.digest);
    expect(firstQualifierTurn).toMatchObject({ complete: false, progress: { visited: 256, root: { count: 256 } } });
    const completedQualifier = await qualifierRoots.prepare(completedQualifierSource.digest);
    expect(completedQualifier).toMatchObject({ complete: true, progress: { visited: 257, root: { count: 257 } } });
    expect(await qualifierRoots.completedQualifierKeys(pendingQualifierSource.digest, pendingQualifierSource.source)).toBeNull();
    expect((await qualifierRoots.completedQualifierKeys(completedQualifierSource.digest,
      completedQualifierSource.source))?.root).toEqual(completedQualifier.progress.root);
    const protectedSet = new Set([pendingSource.digest, completeSource.digest,
      pendingQualifierSource.digest, completedQualifierSource.digest]);
    const retainPage = async (reference: string): Promise<void> => {
      const digest = reference.slice(7);
      if (protectedSet.has(digest)) return;
      protectedSet.add(digest);
      const page = checkStructurePage(await objects.get(digest));
      if (page.level > 0) {
        for (const child of page.entries as Array<{ page: string }>) await retainPage(child.page);
      }
    };
    for (const root of [pendingSource.source.records, pendingSource.source.order, pending.groups,
      completeSource.source.records, completeSource.source.order, complete.groups,
      pendingQualifierSource.source.records, pendingQualifierSource.source.order, pendingQualifier.progress.root,
      completedQualifierSource.source.records, completedQualifierSource.source.order, completedQualifier.progress.root]) {
      await retainPage(root.page);
    }
    const protectedDigests = [...protectedSet];
    // Both source trees have interior roots: ledger coverage must include their
    // child leaves, rather than preserving only the manifest/root pointers.
    expect(protectedDigests.length).toBeGreaterThan(16);
    const originalBytes = new Map(await Promise.all(protectedDigests.map(async digest =>
      [digest, await objects.get(digest)] as const)));
    const holds = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?hold WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?hold } } LIMIT 2`)).results?.bindings ?? [];
    expect(holds.length).toBeLessThanOrEqual(1);
    restoreHold = holds[0]?.hold;
    if (restoreHold) expect(restoreHold.type).toBe('literal');
    await stack.fuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?previous } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      WHERE { OPTIONAL { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?previous } } }`);
    holdChanged = true;

    const operations = new OwnerOperations(relay, stack.env);
    const key = `group-retention-${randomUUID()}`;
    const result = await operations.reconcileRetentionGc(key);
    expect(result).toMatchObject({ kind: 'retention_gc', state: 'reconciled', replayed: false });
    const ledger = await relay.query<{ item_ref: string; item_kind: string; disposition: string; evidence_digest: string }>(
      `SELECT item_ref, item_kind, disposition, evidence_digest FROM relay.owner_reconciliation_item
        WHERE reconciliation_id = $1 AND owner = 'object' AND item_ref = ANY($2::text[])`, [result.id, protectedDigests]);
    expect(ledger.rows).toHaveLength(protectedDigests.length);
    for (const item of ledger.rows) {
      expect(item).toMatchObject({ item_kind: 'retention_pin', disposition: 'preserved', evidence_digest: item.item_ref });
    }
    const cuts = await relay.query<{ owner: string; status: string }>(`SELECT owner, status
      FROM relay.owner_reconciliation_cut WHERE reconciliation_id = $1 ORDER BY owner`, [result.id]);
    expect(cuts.rows).toEqual([{ owner: 'graph', status: 'matched' }, { owner: 'object', status: 'matched' }]);
    expect(await new OwnerOperations(relay, { ...stack.env,
      structureGroupRoots: new StructureGroupRootStore(stack.contentPool, stack.objects('semantic/structure/')),
      structureQualifierRoots: new StructureQualifierRootStore(stack.contentPool, stack.objects('semantic/structure/')) })
      .reconcileRetentionGc(key)).toMatchObject({ id: result.id, state: 'reconciled', replayed: true });
    expect(await roots.read(pendingSource.digest)).toEqual(pending);
    expect(await roots.completedTopGroups(pendingSource.digest, pendingSource.source)).toBeNull();
    expect(await roots.read(completeSource.digest)).toEqual(complete);
    expect(await roots.completedTopGroups(completeSource.digest, completeSource.source)).toEqual(complete.groups);
    expect(await qualifierRoots.read(pendingQualifierSource.digest)).toEqual(pendingQualifier);
    expect(await qualifierRoots.read(completedQualifierSource.digest)).toEqual(completedQualifier);
    expect(await new StructureQualifierRootStore(stack.contentPool, stack.objects('semantic/structure/'))
      .read(completedQualifierSource.digest)).toEqual(completedQualifier);
    for (const digest of protectedDigests) expect(await objects.get(digest)).toEqual(originalBytes.get(digest)!);

    // A malformed custody response cannot masquerade as an empty retained cut.
    // Both required resolver objects remain present at this boundary.
    const malformedQualifierRoots: StructureQualifierRootStore = Object.create(qualifierRoots);
    Object.defineProperty(malformedQualifierRoots, 'retainedRoots', { value: async () => undefined });
    await expect(captureObjectRecoveryCoverage(stack.fuseki, { directory: stack.env.objectDirectory,
      structureObjects: objects, structureGroupRoots: roots, structureQualifierRoots: malformedQualifierRoots }))
      .rejects.toThrow('Qualifier custody is unavailable or corrupt');

    const { structureGroupRoots: _roots, ...missingStoreEnvironment } = stack.env;
    const missingStoreKey = `group-retention-unconfigured-${randomUUID()}`;
    await expect(new OwnerOperations(relay, missingStoreEnvironment).reconcileRetentionGc(missingStoreKey))
      .rejects.toBeInstanceOf(OwnerOperationUnavailable);
    expect((await relay.query(`SELECT id FROM relay.owner_reconciliation WHERE operation_id = $1`,
      [`owner:reconcile:${missingStoreKey}`])).rowCount).toBe(0);

    const { structureQualifierRoots: _qualifierRoots, ...missingQualifierEnvironment } = stack.env;
    const missingQualifierKey = `qualifier-retention-unconfigured-${randomUUID()}`;
    await expect(new OwnerOperations(relay, missingQualifierEnvironment).reconcileRetentionGc(missingQualifierKey))
      .rejects.toBeInstanceOf(OwnerOperationUnavailable);
    expect((await relay.query(`SELECT id FROM relay.owner_reconciliation WHERE operation_id = $1`,
      [`owner:reconcile:${missingQualifierKey}`])).rowCount).toBe(0);

    await expect(new OwnerOperations(relay, { ...stack.env,
      structureQualifierRoots: new StructureQualifierRootStore(unavailableContent, objects) })
      .reconcileRetentionGc(missingQualifierBackendKey)).rejects.toThrow('Qualifier custody is unavailable or corrupt');
    const refusedQualifier = await relay.query<{ id: string; state: string }>(`SELECT id, state
      FROM relay.owner_reconciliation WHERE operation_id = $1`, [`owner:reconcile:${missingQualifierBackendKey}`]);
    expect(refusedQualifier.rows).toHaveLength(1);
    expect(refusedQualifier.rows[0]!.state).toBe('running');
    expect((await relay.query(`SELECT item_ref FROM relay.owner_reconciliation_item
      WHERE reconciliation_id = $1`, [refusedQualifier.rows[0]!.id])).rowCount).toBe(0);
    await relay.query(`UPDATE relay.owner_reconciliation SET state = 'held',
      hold_reason = 'Fixture qualifier custody backend unavailable'
      WHERE operation_id = $1 AND state = 'running'`, [`owner:reconcile:${missingQualifierBackendKey}`]);

    // A real PostgreSQL connection to a nonexistent database must refuse GC;
    // an unavailable mapping owner cannot be represented as zero retained rows.
    await expect(new OwnerOperations(relay, { ...stack.env,
      structureGroupRoots: new StructureGroupRootStore(unavailableContent, objects) })
      .reconcileRetentionGc(missingBackendKey)).rejects.toThrow('Structure group custody owner is unavailable or corrupt');
    const refused = await relay.query<{ id: string; state: string }>(`SELECT id, state
      FROM relay.owner_reconciliation WHERE operation_id = $1`, [`owner:reconcile:${missingBackendKey}`]);
    expect(refused.rows).toHaveLength(1);
    expect(refused.rows[0]!.state).toBe('running');
    expect((await relay.query(`SELECT item_ref FROM relay.owner_reconciliation_item
      WHERE reconciliation_id = $1`, [refused.rows[0]!.id])).rowCount).toBe(0);
    for (const digest of protectedDigests) expect(await objects.get(digest)).toEqual(originalBytes.get(digest)!);
    expect(await roots.read(pendingSource.digest)).toEqual(pending);
    expect(await roots.read(completeSource.digest)).toEqual(complete);
    expect(await qualifierRoots.read(pendingQualifierSource.digest)).toEqual(pendingQualifier);
    expect(await qualifierRoots.read(completedQualifierSource.digest)).toEqual(completedQualifier);
  } finally {
    // A failed backend pass remains an explicit held fixture record and must
    // release the one-running-pass constraint for later isolated QA cases.
    try {
      await relay.query(`UPDATE relay.owner_reconciliation SET state = 'held',
        hold_reason = 'Fixture group custody backend unavailable'
        WHERE operation_id = ANY($1::text[]) AND state = 'running'`,
      [[`owner:reconcile:${missingBackendKey}`, `owner:reconcile:${missingQualifierBackendKey}`]]);
    } finally {
      try {
        if (holdChanged) {
          const original = restoreHold
            ? `${lit(restoreHold.value)}${restoreHold.datatype ? `^^${iri(restoreHold.datatype)}` : ''}` : null;
          await stack.fuseki.update(`PREFIX rv: <${RV}>
            DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?previous } }
            ${original ? `INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ${original} } }` : ''}
            WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?previous } }`);
        }
      } finally { await Promise.all([relay.end(), unavailableContent.end(), stack.stop()]); }
    }
  }
}, 180_000);
