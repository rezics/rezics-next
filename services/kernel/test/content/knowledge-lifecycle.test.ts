import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createKnowledgeDiscoverySource } from '../../src/content/knowledge-discovery.ts';
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

test('subtree admission is truthfully incomplete; current ancestors and moves fence lifecycle commands', async () => {
  const w = await workspace();
  const root = await w.create('Root');
  const child = await w.create('Child', root.placementId);
  const sibling = await w.create('Sibling');
  const trashRoot = `/v1/knowledge/documents/${root.documentId}:trash`;
  const incomplete = await f.call('POST', trashRoot, w.input('0'));
  expect(incomplete.status).toBe(200);
  expect(incomplete.value).toMatchObject({
    complete: false,
    reason: 'subtree_work_required',
    state: 'active',
    generation: '0',
  });
  expect((await f.call('GET', w.privatePath(child.documentId))).status).toBe(200);
  const oldInput = w.input('0');
  const moved = await f.command(
    `/v1/knowledge/notebooks/${w.notebook.notebookId}/placements/${child.placementId}:move`,
    {
      expectedStructureRevisionId: w.structure(),
      destinationParentPlacementId: sibling.placementId,
      beforePlacementId: null,
    },
    200,
  );
  expect((await f.call('POST', `/v1/knowledge/documents/${child.documentId}:trash`, oldInput)).status).toBe(412);
  // A future subtree root uses the same current ancestor eligibility, without rewriting its descendants.
  await setLifecycle(
    sibling.documentId,
    'deleted_at=clock_timestamp(),lifecycle_generation=1,current_publication_id=NULL',
  );
  expect(
    (
      await f.call('POST', `/v1/knowledge/documents/${child.documentId}:trash`, {
        expectedStructureRevisionId: moved.structureRevisionId,
        expectedGeneration: '0',
      })
    ).status,
  ).toBe(404);
  expect((await f.call('GET', w.privatePath(child.documentId))).status).toBe(404);
  expect((await f.call('GET', `${w.privatePath(child.documentId)}/history`)).status).toBe(404);
  const restoreIncomplete = await f.call('POST', `/v1/knowledge/documents/${sibling.documentId}:restore`, {
    expectedStructureRevisionId: moved.structureRevisionId,
    expectedGeneration: '1',
  });
  expect(restoreIncomplete.value).toMatchObject({
    complete: false,
    reason: 'subtree_work_required',
    state: 'trashed',
    generation: '1',
  });
  expect((await f.call('GET', w.privatePath(root.documentId))).status).toBe(200);
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
