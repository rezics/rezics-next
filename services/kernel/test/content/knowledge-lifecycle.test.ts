import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createKnowledgeDiscoverySource } from '../../src/content/knowledge-discovery.ts';
import { advanceKnowledgeLifecycleRestorePage } from '../../src/content/knowledge-lifecycle-work.ts';
import { routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
beforeAll(async () => {
  f = await postPublicationFixture();
});
afterAll(async () => {
  await f?.close();
});
const body = (title: string) => ({ title, body: fromPlainText(title), licence: 'MIT', subjectIds: [] });

async function workspace() {
  const { subject } = await f.command('/v1/subjects', { type: 'skos:Concept', labels: { en: 'Lifecycle' } });
  const notebook = await f.command('/v1/knowledge/notebooks', { subjectId: subject.id, title: 'Private notebook' });
  let structure = notebook.structureRevisionId as string;
  const create = async (title: string, parentPlacementId: string | null = null) => {
    const document = await f.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
      ...body(title),
      expectedStructureRevisionId: structure,
      parentPlacementId,
    });
    structure = document.structureRevisionId;
    return document;
  };
  const privatePath = (id: string) =>
    `/v1/accounts/${f.author.actor.accountId}/knowledge/notebooks/${notebook.notebookId}/documents/${id}`;
  return {
    notebook,
    create,
    privatePath,
    structure: () => structure,
    input: (expectedGeneration: string) => ({ expectedGeneration, expectedStructureRevisionId: structure }),
  };
}

async function setLifecycle(documentId: string, sql: string) {
  // Fault/retention fixtures only; all user mutations and disclosure assertions use mounted native routes.
  await f.pool.query(`UPDATE content.knowledge_document SET ${sql} WHERE route=$1 AND document_id=$2`, [
    routeOf(documentId),
    documentId,
  ]);
}

test('native leaf trash fences every representation and lagged discovery; restore retains history without republishing', async () => {
  const w = await workspace();
  const note = await w.create('Private v1');
  const sibling = await w.create('Unrelated branch');
  const privatePath = w.privatePath(note.documentId);
  const v1 = (await f.call('GET', privatePath)).value.document;
  const v2 = await f.command(
    `/v1/knowledge/documents/${note.documentId}/revisions:revise`,
    { ...body('Private v2'), expectedHeadRevisionId: note.revisionId },
    200,
  );
  const publishPath = `/v1/knowledge/documents/${note.documentId}/publication:select`;
  const publication = await f.command(
    publishPath,
    { expectedHeadRevisionId: v2.revisionId, expectedPublicationId: null, revisionId: note.revisionId },
    200,
  );
  const source = createKnowledgeDiscoverySource({ pool: f.pool, access: f.system.access });
  const context = () => ({ deadline: Date.now() + 30_000 });
  const candidate = await source.selected(note.documentId, publication.publicationId, context());
  expect(candidate).not.toBeNull();
  await setLifecycle(note.documentId, 'legal_hold=true');

  const trashPath = `/v1/knowledge/documents/${note.documentId}:trash`;
  const restorePath = `/v1/knowledge/documents/${note.documentId}:restore`;
  const input = w.input('0');
  expect((await f.call('POST', trashPath, input, { other: true })).status).toBe(404);
  expect((await f.call('POST', trashPath, { ...input, expectedGeneration: '01' })).status).toBe(400);
  const trashed = await f.call('POST', trashPath, input, { key: 'knowledge-trash-replay' });
  expect(trashed.status, JSON.stringify(trashed.value)).toBe(200);
  expect(trashed.value).toMatchObject({ complete: true, reason: null, generation: '1', state: 'trashed' });
  expect(Date.parse(trashed.value.restoreUntil)).toBeGreaterThan(Date.now() + 29 * 86400000);
  expect((await f.call('POST', trashPath, input, { key: 'knowledge-trash-replay' })).value).toEqual(trashed.value);
  expect((await f.call('POST', trashPath, input, { key: 'knowledge-trash-replay', other: true })).status).toBe(404);
  const lifecycle = await f.call('GET', `${privatePath}/lifecycle`);
  expect(lifecycle.status).toBe(200);
  expect(lifecycle.value.generation).toBe('1');
  expect(JSON.stringify(lifecycle.value)).not.toContain('Private');
  expect((await f.call('GET', `${privatePath}/lifecycle`, undefined, { other: true })).status).toBe(404);

  for (const path of [
    privatePath,
    `${privatePath}?revisionId=${note.revisionId}`,
    `${privatePath}/history`,
    `${privatePath}/compare?leftRevisionId=${note.revisionId}&rightRevisionId=${v2.revisionId}`,
    `${privatePath}/export?revisionId=${note.revisionId}`,
  ]) {
    const result = await f.call('GET', path);
    expect(result.status, path).toBe(404);
    expect(JSON.stringify(result.value)).not.toContain(v1.canonicalBytes);
  }
  for (const suffix of ['', `?revisionId=${note.revisionId}`, '/export']) {
    expect(
      (await f.call('GET', `/v1/knowledge/documents/${note.documentId}${suffix}`, undefined, { anonymous: true }))
        .status,
    ).toBe(404);
  }
  expect(await source.selected(note.documentId, publication.publicationId, context())).toBeNull();
  expect(await source.current(candidate!, context())).toEqual({ status: 'ready', value: null });
  for (const sourceSelection of [
    { representation: 'public', documentId: note.documentId, revisionId: note.revisionId },
    {
      representation: 'authoring',
      accountId: f.author.actor.accountId,
      notebookId: w.notebook.notebookId,
      documentId: note.documentId,
      revisionId: note.revisionId,
    },
  ]) {
    expect(
      (
        await f.call('POST', `/v1/knowledge/notebooks/${w.notebook.notebookId}/documents:copy`, {
          source: sourceSelection,
          expectedStructureRevisionId: w.structure(),
          parentPlacementId: null,
        })
      ).status,
    ).toBe(404);
  }
  expect(
    (
      await f.call('POST', `/v1/knowledge/documents/${note.documentId}/revisions:revise`, {
        ...body('Cannot edit trash'),
        expectedHeadRevisionId: v2.revisionId,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.call('POST', publishPath, {
        expectedHeadRevisionId: v2.revisionId,
        expectedPublicationId: null,
        revisionId: note.revisionId,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.call('POST', `/v1/knowledge/notebooks/${w.notebook.notebookId}/documents`, {
        ...body('Cannot insert into trash'),
        expectedStructureRevisionId: w.structure(),
        parentPlacementId: note.placementId,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.call('POST', `/v1/knowledge/notebooks/${w.notebook.notebookId}/placements/${note.placementId}:move`, {
        expectedStructureRevisionId: w.structure(),
        destinationParentPlacementId: sibling.placementId,
        beforePlacementId: null,
      })
    ).status,
  ).toBe(404);
  const outlinePath = `/v1/accounts/${f.author.actor.accountId}/knowledge/notebooks/${w.notebook.notebookId}/outline`;
  for (const suffix of ['', `?revisionId=${w.structure()}`]) {
    const outline = await f.call('GET', outlinePath + suffix);
    expect(outline.status).toBe(200);
    expect(outline.value.placements.map((p: { documentId: string }) => p.documentId)).toEqual([sibling.documentId]);
    expect(JSON.stringify(outline.value)).not.toContain('Private v');
  }
  expect((await f.call('GET', w.privatePath(sibling.documentId))).status).toBe(200);
  expect((await f.call('POST', restorePath, w.input('0'))).status).toBe(412);
  // Unrelated work continues; recovery must use the current structure, even when only a sibling changed.
  await w.create('Another unrelated root');
  expect((await f.call('POST', restorePath, { ...input, expectedGeneration: '1' })).status).toBe(412);
  const restored = await f.call('POST', restorePath, w.input('1'), { key: 'knowledge-restore-replay' });
  expect(restored.status, JSON.stringify(restored.value)).toBe(200);
  expect(restored.value).toMatchObject({
    documentId: note.documentId,
    complete: true,
    generation: '2',
    state: 'active',
    restoreUntil: null,
  });
  expect((await f.call('POST', restorePath, w.input('1'), { key: 'knowledge-restore-replay' })).value).toEqual(
    restored.value,
  );
  expect((await f.call('POST', restorePath, w.input('1'))).status).toBe(412);
  expect((await f.call('GET', `${privatePath}?revisionId=${note.revisionId}`)).value.document.canonicalBytes).toBe(
    v1.canonicalBytes,
  );
  const privateHead = (await f.call('GET', privatePath)).value.document;
  expect(privateHead.revisionId).toBe(v2.revisionId);
  expect(privateHead.publicationId).toBeNull();
  expect((await f.call('GET', `${privatePath}/history`)).value.revisions).toHaveLength(2);
  expect(
    (await f.call('GET', `/v1/knowledge/documents/${note.documentId}`, undefined, { anonymous: true })).status,
  ).toBe(404);
  expect(await source.current(candidate!, context())).toEqual({ status: 'ready', value: null });
  // Even a lagged pointer cannot revive a retired public generation.
  await f.pool.query(
    `UPDATE content.knowledge_document SET current_publication_id=$3 WHERE route=$1 AND document_id=$2`,
    [routeOf(note.documentId), note.documentId, publication.publicationId],
  );
  expect(
    (await f.call('GET', `/v1/knowledge/documents/${note.documentId}`, undefined, { anonymous: true })).status,
  ).toBe(404);
  expect(await source.selected(note.documentId, publication.publicationId, context())).toBeNull();
  const republished = await f.command(
    publishPath,
    {
      expectedHeadRevisionId: v2.revisionId,
      expectedPublicationId: publication.publicationId,
      revisionId: note.revisionId,
    },
    200,
  );
  expect(republished.publicationId).not.toBe(publication.publicationId);
  expect(
    (await f.call('GET', `/v1/knowledge/documents/${note.documentId}`, undefined, { anonymous: true })).status,
  ).toBe(200);
  const state = await f.pool.query(
    `SELECT legal_hold,lifecycle_generation::text FROM content.knowledge_document WHERE route=$1 AND document_id=$2`,
    [routeOf(note.documentId), note.documentId],
  );
  expect(state.rows[0]).toEqual({ legal_hold: true, lifecycle_generation: '2' });
  const events = await f.pool.query(
    `SELECT type,data FROM core.outbox WHERE subject=$1 AND type='com.rezics.content.knowledge.lifecycle.changed.v1' ORDER BY position,event_seq`,
    [note.documentId],
  );
  expect(events.rows.map((e) => e.data.action)).toEqual(['trash', 'restore']);
  expect(JSON.stringify(events.rows)).not.toContain('Private v');
});

test('subtree trash fences descendants and durable restore resumes privately around nested trash', async () => {
  const w = await workspace();
  const root = await w.create('Root');
  const child = await w.create('Child', root.placementId);
  const nested = await w.create('Nested trashed root', child.placementId);
  const nestedChild = await w.create('Nested child', nested.placementId);
  const unrelated = await w.create('Unrelated branch');
  const publish = async (note: { documentId: string; revisionId: string }) =>
    f.command(
      `/v1/knowledge/documents/${note.documentId}/publication:select`,
      { expectedHeadRevisionId: note.revisionId, expectedPublicationId: null, revisionId: note.revisionId },
      200,
    );
  const childPublication = await publish({ documentId: child.documentId, revisionId: child.revisionId });
  await publish({ documentId: nestedChild.documentId, revisionId: nestedChild.revisionId });

  const nestedTrash = await f.call('POST', `/v1/knowledge/documents/${nested.documentId}:trash`, w.input('0'));
  expect(nestedTrash.value).toMatchObject({ complete: true, state: 'trashed', generation: '1' });
  const rootTrash = await f.call('POST', `/v1/knowledge/documents/${root.documentId}:trash`, w.input('0'));
  expect(rootTrash.status).toBe(200);
  expect(rootTrash.value).toMatchObject({ complete: true, reason: null, state: 'trashed', generation: '1' });
  for (const id of [root.documentId, child.documentId, nested.documentId, nestedChild.documentId])
    expect((await f.call('GET', w.privatePath(id))).status).toBe(404);
  expect((await f.call('GET', w.privatePath(unrelated.documentId))).status).toBe(200);
  expect(
    (await f.call('GET', `/v1/knowledge/documents/${child.documentId}`, undefined, { anonymous: true })).status,
  ).toBe(404);

  const restore = await f.call('POST', `/v1/knowledge/documents/${root.documentId}:restore`, w.input('1'));
  expect(restore.value).toMatchObject({
    complete: false,
    reason: 'restoring',
    generation: '2',
    state: 'trashed',
    restoreProgress: { processedDocuments: '0', pendingPlacements: '1' },
  });
  const lifecyclePath = `${w.privatePath(root.documentId)}/lifecycle`;
  expect((await f.call('GET', lifecyclePath)).value.restoreProgress).toEqual(restore.value.restoreProgress);
  expect(JSON.stringify((await f.call('GET', lifecyclePath)).value)).not.toContain('Child');
  expect((await f.call('GET', w.privatePath(child.documentId))).status).toBe(404);
  expect(
    (
      await f.call('POST', `/v1/knowledge/documents/${child.documentId}/revisions:revise`, {
        ...body('Blocked during restore'),
        expectedHeadRevisionId: child.revisionId,
      })
    ).status,
  ).toBe(404);
  const moveChildOut = await f.call(
    'POST',
    `/v1/knowledge/notebooks/${w.notebook.notebookId}/placements/${child.placementId}:move`,
    {
      expectedStructureRevisionId: w.structure(),
      destinationParentPlacementId: null,
      beforePlacementId: null,
    },
  );
  expect(moveChildOut.status).toBe(404);
  const moveUnrelatedIn = await f.call(
    'POST',
    `/v1/knowledge/notebooks/${w.notebook.notebookId}/placements/${unrelated.placementId}:move`,
    {
      expectedStructureRevisionId: w.structure(),
      destinationParentPlacementId: root.placementId,
      beforePlacementId: null,
    },
  );
  expect(moveUnrelatedIn.status).toBe(404);

  // Unrelated structure work proceeds while the hidden subtree is frozen.
  const another = await w.create('Another unrelated branch');
  expect((await f.call('GET', w.privatePath(another.documentId))).status).toBe(200);
  const operation = await f.pool.query<{ operation_id: string }>(
    `SELECT operation_id FROM content.knowledge_lifecycle_restore
     WHERE route=$1 AND root_document_id=$2 AND state='running'`,
    [routeOf(root.documentId), root.documentId],
  );
  const operationId = operation.rows[0]!.operation_id;

  // Each call is a fresh worker invocation. The committed cursor, not process memory, resumes the walk.
  const firstPage = await advanceKnowledgeLifecycleRestorePage(f.pool, f.system.access, operationId, () => new Date());
  expect(firstPage).toMatchObject({ state: 'running', complete: false, processedDocuments: '1' });
  expect((await f.call('GET', w.privatePath(root.documentId))).status).toBe(404);
  const secondPage = await advanceKnowledgeLifecycleRestorePage(f.pool, f.system.access, operationId, () => new Date());
  expect(secondPage).toMatchObject({ state: 'complete', complete: true, pendingPlacements: '0' });

  expect((await f.call('GET', w.privatePath(root.documentId))).status).toBe(200);
  const restoredChild = (await f.call('GET', w.privatePath(child.documentId))).value.document;
  expect(restoredChild.publicationId).toBeNull();
  expect((await f.call('GET', w.privatePath(nested.documentId))).status).toBe(404);
  expect((await f.call('GET', w.privatePath(nestedChild.documentId))).status).toBe(404);
  expect((await f.call('GET', w.privatePath(another.documentId))).status).toBe(200);

  // A delayed old selection cannot pass the child's advanced lifecycle generation.
  await f.pool.query(
    `UPDATE content.knowledge_document SET current_publication_id=$3 WHERE route=$1 AND document_id=$2`,
    [routeOf(child.documentId), child.documentId, childPublication.publicationId],
  );
  expect(
    (await f.call('GET', `/v1/knowledge/documents/${child.documentId}`, undefined, { anonymous: true })).status,
  ).toBe(404);
});

test('retention, purge start and completed purge deny recovery and old receipts; competing generations have one winner', async () => {
  const w = await workspace();
  const note = await w.create('Recoverable');
  const trashPath = `/v1/knowledge/documents/${note.documentId}:trash`;
  const restorePath = `/v1/knowledge/documents/${note.documentId}:restore`;
  const competing = await Promise.all([
    f.call('POST', trashPath, w.input('0'), { key: 'knowledge-race-a' }),
    f.call('POST', trashPath, w.input('0'), { key: 'knowledge-race-b' }),
  ]);
  expect(competing.map((r) => r.status).sort()).toEqual([200, 412]);
  const winningKey = competing[0]!.status === 200 ? 'knowledge-race-a' : 'knowledge-race-b';
  for (const fault of [
    "deleted_at=clock_timestamp()-interval '30 days',legal_hold=true",
    'deleted_at=clock_timestamp(),purge_started_at=clock_timestamp()',
    'purge_started_at=NULL,purge_completed=true',
  ]) {
    await setLifecycle(note.documentId, fault);
    expect((await f.call('POST', restorePath, w.input('1'))).status).toBe(404);
    expect((await f.call('POST', trashPath, w.input('0'), { key: winningKey })).status).toBe(404);
    expect((await f.call('GET', `${w.privatePath(note.documentId)}/lifecycle`)).status).toBe(404);
  }
});
