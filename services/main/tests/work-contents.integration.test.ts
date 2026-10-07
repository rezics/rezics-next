import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../src/app.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { StructureProgressStore } from '../src/modules/progress/store.ts';
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
  const stack = await startMediaStack('chapter-place');
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
  const stack = await startMediaStack('structure-group-order');
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
