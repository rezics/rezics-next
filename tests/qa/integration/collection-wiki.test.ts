import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { moveCollectionDisplayGroup }
  from '../../../services/main/src/modules/collection/display-group.ts';
import { GraphLayouts } from '../../../services/main/src/modules/graph-layout/store.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { collectionRoutes } from '../../../services/main/src/routes/collections.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';

test('WIKI03/WIKI06/CTX08: a Collection keeps repeated occurrence history and hides private members', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `collection-wiki-${randomUUID()}`),
    'openid work:create work:edit work:read collection:edit semantic:read');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const visibleWork = await f.json<{ work: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Visible member', actingSubject: f.actor,
    }), 201);
    const privateWork = await f.json<{ work: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Private member', actingSubject: f.actor,
    }), 201);
    await f.grant(`work:read:${visibleWork.work}`, 'work.read');
    const privateGrant = await f.grant(`work:read:${privateWork.work}`, 'work.read');
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const create = { collection, name: 'Public collection', disclosure: 'public', actingSubject: f.actor };
    const createKey = `collection-${randomUUID()}`;
    const created = await f.json<{ structure: string; revision: string; replayed: boolean }>(
      await f.call('POST', '/v1/collections', create, createKey), 201);
    expect(created.replayed).toBe(false);
    expect(await f.json<{ structure: string; replayed: boolean }>(
      await f.call('POST', '/v1/collections', create, createKey), 200)).toMatchObject({
      structure: created.structure, replayed: true,
    });
    const path = `/v1/collections/${shortId(collection)}`;
    const insert = { expectedHead: created.revision, actingSubject: f.actor,
      operations: [visibleWork.work, visibleWork.work, privateWork.work].map(target => ({
        op: 'insert', role: 'member', parent: created.structure, position: 'last', target,
        selection: { mode: 'follow-context' },
      })) };
    const inserted = await f.json<{ revision: string; occurrences: string[]; cost: {
      placementsWritten: number } }>(await f.call('POST', `${path}/changes`, insert), 200);
    expect(inserted.occurrences).toHaveLength(3);
    expect(new Set(inserted.occurrences).size).toBe(3);
    expect(inserted.cost.placementsWritten).toBe(3);
    const move = { expectedHead: inserted.revision, actingSubject: f.actor,
      operations: [{ op: 'move', occurrence: inserted.occurrences[1], parent: created.structure,
        position: 'first' }] };
    const moved = await f.json<{ revision: string }>(await f.call('POST', `${path}/changes`, move), 200);
    const query = `actingSubject=${encodeURIComponent(f.actor)}`;
    const current = await f.json<{ occurrences: Array<{ occurrence: string }> }>(
      await f.call('GET', `${path}?${query}`), 200);
    expect(current.occurrences.map(item => item.occurrence).slice(0, 2)).toEqual([
      inserted.occurrences[1], inserted.occurrences[0],
    ]);
    const historical = await f.json<{ revision: string; occurrences: Array<{ occurrence: string }> }>(
      await f.call('GET', `${path}/revisions/${shortId(inserted.revision)}?${query}`), 200);
    expect(historical.revision).toBe(inserted.revision);
    expect(historical.occurrences.map(item => item.occurrence).slice(0, 2)).toEqual([
      inserted.occurrences[0], inserted.occurrences[1],
    ]);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [privateGrant]);
    const disclosed = await f.json<{ occurrences: Array<{ target: string; occurrence: string }>;
      next: string | null }>(await f.call('GET', `${path}?${query}`), 200);
    expect(disclosed.occurrences).toHaveLength(2);
    expect(disclosed.occurrences.every(item => item.target === visibleWork.work)).toBe(true);
    expect(JSON.stringify(disclosed)).not.toContain(privateWork.work);
    expect(JSON.stringify(disclosed)).not.toContain('Private member');
    expect(JSON.stringify(disclosed)).not.toContain(inserted.occurrences[2]!);
    expect(JSON.stringify(disclosed)).not.toContain('authorizationChecks');
    expect(JSON.stringify(disclosed)).not.toContain('pagesRead');
    expect(disclosed.next).toBeNull();
    const firstVisible = await f.json<{ occurrences: Array<{ occurrence: string }>;
      next: string | null }>(await f.call('GET', `${path}?${query}&limit=1`), 200);
    expect(firstVisible.occurrences).toHaveLength(1);
    expect(firstVisible.next).toBeTruthy();
    const lastVisible = await f.json<{ occurrences: Array<{ occurrence: string }>;
      next: string | null }>(await f.call('GET', `${path}?${query}&limit=1`
      + `&after=${encodeURIComponent(firstVisible.next!)}`), 200);
    expect(lastVisible.occurrences).toHaveLength(1);
    expect(lastVisible.next).toBeNull();
    expect([firstVisible.occurrences[0]?.occurrence, lastVisible.occurrences[0]?.occurrence])
      .toEqual([inserted.occurrences[1], inserted.occurrences[0]]);
    expect((await f.call('POST', `${path}/changes`, move, `collection-${randomUUID()}`)).status).toBe(409);
    // CTX08 display groups are view state; moving one creates no Jena fact or Statement.
    const statements = async () => (await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?statement WHERE { GRAPH <urn:rezics:graph:current> {
        ?statement a rv:Statement . } } ORDER BY ?statement`)).results?.bindings
      ?.map(row => row.statement?.value) ?? [];
    const beforeGroups = await statements();
    const graphSnapshot = 'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o';
    const beforeGraph = await f.env.fuseki.query(graphSnapshot);
    const layout = { view: { profile: 'https://rezics.com/definition/relationship-view-v1',
      anchor: collection, context: null }, nodes: [{ resource: visibleWork.work,
        x: 10, y: 20, group: 'appearance', pinned: true }],
      groups: [{ id: 'appearance', label: 'Appearance', x: 0, y: 0, collapsed: false }] };
    const relocated = moveCollectionDisplayGroup(layout, 'appearance',
      { x: 100, y: 200, collapsed: true });
    expect(relocated.groups[0]).toMatchObject({ id: 'appearance', x: 100, y: 200,
      collapsed: true });
    expect(relocated.nodes).toEqual(layout.nodes);
    await f.grant('graph-layout:write', 'graph.layout.write');
    const layouts = new GraphLayouts(f.accessPool, f.pool, new ContentCore(f.pool));
    const actor = { principal: await f.account.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${f.account.tokenA}` },
    }), ['work:edit']), actingSubject: f.actor };
    const saved = await layouts.save(actor, null, null, layout,
      { idempotencyKey: `collection-layout-${randomUUID()}`,
        requestDigest: hash(JSON.stringify(layout)) });
    const collectionApp = collectionRoutes(f.env.fuseki, { environment: f.env,
      account: f.account.verifier, access: f.access, structureObjects: objects,
      graphLayouts: layouts } as Parameters<typeof collectionRoutes>[1]);
    const movePath = `/v1/collections/${shortId(collection)}/display-groups/appearance/moves`;
    const moveBody = { layout: saved.layout, expectedHead: saved.revision,
      actingSubject: f.actor, placement: { x: 100, y: 200, collapsed: true } };
    const moveKey = `display-move-${randomUUID()}`;
    const moveRequest = (body: object, key: string, token = f.account.tokenA) =>
      collectionApp.handle(new Request(`http://main.local${movePath}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    const savedMove = await f.json<{ revision: string; replayed: boolean }>(await moveRequest(
      moveBody, moveKey), 200);
    expect((await layouts.read(actor, saved.layout)).body).toEqual(relocated);
    expect((await layouts.read(actor, saved.layout, saved.revision)).body).toEqual(layout);
    expect((await f.json<{ revision: string; replayed: boolean }>(await moveRequest(
      moveBody, moveKey), 200))).toMatchObject({ revision: savedMove.revision, replayed: true });
    expect((await moveRequest({ ...moveBody, placement: { x: 101, y: 200, collapsed: true } },
      moveKey)).status).toBe(409);
    expect((await moveRequest({ ...moveBody, expectedHead: saved.revision },
      `display-stale-${randomUUID()}`)).status).toBe(409);
    expect((await moveRequest(moveBody, `display-denied-${randomUUID()}`,
      f.account.tokenB)).status).toBe(403);
    expect(await f.env.fuseki.query(graphSnapshot)).toEqual(beforeGraph);
    const afterGroups = await statements();
    expect(afterGroups).toEqual(beforeGroups);
    const concurrent = await Promise.all([
      f.call('POST', `${path}/changes`, { expectedHead: moved.revision,
        actingSubject: f.actor, operations: [{ op: 'move', occurrence: inserted.occurrences[0],
          parent: created.structure, position: 'last' }] }),
      f.call('POST', `${path}/changes`, { expectedHead: moved.revision,
        actingSubject: f.actor, operations: [{ op: 'move', occurrence: inserted.occurrences[1],
          parent: created.structure, position: 'last' }] }),
    ]);
    expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
    expect((await f.json<{ occurrences: Array<{ occurrence: string }> }>(await f.call('GET',
      `${path}?${query}`), 200)).occurrences).toHaveLength(2);
    expect((await f.call('GET', `${path}?${query}`, undefined, randomUUID(), f.account.tokenB)).status)
      .toBe(404);
  } finally { await f.close(); }
}, 180_000);
