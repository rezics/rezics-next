import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { ObjectIntegrityError, ObjectUnavailable, S3ImmutableObjects,
  type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { checkStructureSealManifest } from '../../../services/main/src/modules/structure/format.ts';
import { readCompositionSeal } from '../../../services/main/src/modules/structure/seal-read.ts';
import { readExportPlan } from '../../../services/main/src/modules/export/readers.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { progressRoutes } from '../../../services/main/src/routes/progress.ts';

type Created = { structure: string; revision: string; receipt: string; replayed: boolean };
type Changed = Created & { occurrences: string[]; cost: { pagesRead: number;
  pagesWritten: number; placementsWritten: number; segmentsWritten: number; rebalanced: number } };
type Page = { revision: string; predecessor: string | null; placementCount: number;
  occurrences: Array<{ occurrence: string; state: string; parent: string; target?: string;
    orderKey: string; sourceKey?: string }>; next: string | null; cost: { pagesRead: number } };

test('BOOK02/COMP01/COMP02/COMP05/COMP06: admitted Book composition keeps occurrence identity and exact heads', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structure-composition-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  const objectEnv = f.env as typeof f.env & { structureObjects: ImmutableObjects };
  objectEnv.structureObjects = objects;
  const progressApp = new Elysia().use(progressRoutes(f.env.fuseki, {
    environment: f.env, catalogueIntake: f.catalogueIntake, account: f.account.verifier, access: f.access,
    structureObjects: objects, progress: new StructureProgressStore(f.pool),
  }));
  const progressCall = (method: string, path: string, body?: object, key = randomUUID(),
    token = f.account.tokenA) => progressApp.handle(new Request(`http://main.local${path}`,
      { method, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
      await f.catalogueBody({ profile: 'metadata-only-v1', language: 'en', title: 'Book composition',
        semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor })), 201);
    const createBody = { profile: 'book-composition', work: work.work,
      mainVersion: work.mainVersion, actingSubject: f.actor };
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`work:edit:${work.work}`]);
    const createKey = `composition-${randomUUID()}`;
    expect((await f.call('POST', '/v1/compositions', createBody, createKey, f.account.noScope)).status)
      .toBe(401);
    expect((await f.call('POST', '/v1/compositions', createBody, createKey)).status).toBe(403);
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const createResponse = await f.call('POST', '/v1/compositions', createBody, createKey);
    if (createResponse.status !== 201) throw new Error(`composition create: ${createResponse.status} ${await createResponse.text()}`);
    const created = await f.json<Created>(createResponse, 201);
    expect(created.replayed).toBe(false);
    expect(await f.json<Created>(await f.call('POST', '/v1/compositions', createBody,
      createKey), 200)).toMatchObject({ structure: created.structure,
      revision: created.revision, receipt: created.receipt, replayed: true });
    const path = `/v1/compositions/${shortId(created.structure)}`;
    const read = `${path}?actingSubject=${encodeURIComponent(f.actor)}`;
    expect((await f.call('GET', read, undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const empty = await f.json<Page>(await f.call('GET', read), 200);
    expect(empty).toMatchObject({ revision: created.revision, placementCount: 0, occurrences: [] });

    const changeKey = `composition-${randomUUID()}`;
    const insert = { profile: 'book-composition', expectedHead: created.revision,
      actingSubject: f.actor, operations: [
        { op: 'insert', parent: created.structure, position: 'last', role: 'chapter', target: work.work,
          sourceKey: 'source:/chapters/one' },
        { op: 'insert', parent: created.structure, position: 'last', role: 'chapter', target: work.work,
          sourceKey: 'source:/chapters/two' },
      ] };
    const changeResponse = await f.call('POST', `${path}/changes`, insert, changeKey);
    if (changeResponse.status !== 200) throw new Error(`composition change: ${changeResponse.status} ${await changeResponse.text()}`);
    const changed = await f.json<Changed>(changeResponse, 200);
    expect(changed.occurrences).toHaveLength(2);
    expect(new Set(changed.occurrences).size).toBe(2);
    expect(changed.occurrences).not.toContain(work.work);
    expect(changed.cost.placementsWritten).toBe(2);
    const replay = await f.json<Changed>(await f.call('POST', `${path}/changes`, insert,
      changeKey), 200);
    expect(replay.replayed).toBe(true);
    expect(replay.revision).toBe(changed.revision);
    expect((await f.call('POST', `${path}/changes`, { ...insert,
      operations: insert.operations.slice(0, 1) }, changeKey)).status).toBe(409);
    const current = await f.json<Page>(await f.call('GET', read), 200);
    expect(current.occurrences.map(item => item.occurrence)).toEqual(changed.occurrences);
    expect(current.occurrences.map(item => item.target)).toEqual([work.work, work.work]);
    expect(current.occurrences.map(item => item.sourceKey)).toEqual([
      'source:/chapters/one', 'source:/chapters/two']);
    const listItems = await f.env.fuseki.query(`PREFIX schema: <https://schema.org/>
      PREFIX rv: <https://rezics.com/vocab/> SELECT ?item ?target ?role ?order WHERE {
        GRAPH ${iri(GRAPHS.current)} {
          VALUES ?item { ${changed.occurrences.map(iri).join(' ')} }
          ?item a schema:ListItem .
          ${iri(created.structure)} rv:selectedGeneration ?generation .
          ?placement rv:occurrence ?item ; rv:generation ?generation ;
            schema:item ?target ; rv:occurrenceRole ?role ; rv:orderKey ?order .
        } }`);
    expect(listItems.results?.bindings).toHaveLength(2);
    expect(new Set(listItems.results!.bindings.map(row => row.item!.value)).size).toBe(2);
    expect(listItems.results!.bindings.map(row => row.target!.value))
      .toEqual([work.work, work.work]);
    expect(listItems.results!.bindings.map(row => row.role!.value))
      .toEqual(['https://rezics.com/vocab/ChapterRole', 'https://rezics.com/vocab/ChapterRole']);
    const progressPaths = changed.occurrences.map(occurrence =>
      `${path}/occurrences/${shortId(occurrence)}/progress`);
    const progressBody = (position: string) => ({ actingSubject: f.actor,
      expectedVersion: 0, completed: false, position });
    const firstProgressKey = `progress-${randomUUID()}`;
    const firstProgress = await f.json<{ position: string; version: number; replayed: boolean }>(
      await progressCall('PUT', progressPaths[0]!, progressBody('page:7'), firstProgressKey), 200);
    expect(firstProgress).toMatchObject({ position: 'page:7', version: 1, replayed: false });
    expect(await f.json(await progressCall('PUT', progressPaths[0]!,
      progressBody('page:7'), firstProgressKey), 200)).toMatchObject({ replayed: true,
      position: 'page:7', version: 1 });
    expect(await f.json(await progressCall('PUT', progressPaths[1]!,
      progressBody('page:19')), 200)).toMatchObject({ position: 'page:19', version: 1 });
    expect((await progressCall('PUT', progressPaths[0]!, progressBody('page:8'))).status).toBe(409);
    const progressQuery = `?actingSubject=${encodeURIComponent(f.actor)}`;
    expect(await f.json(await progressCall('GET', progressPaths[0]! + progressQuery), 200))
      .toMatchObject({ position: 'page:7', version: 1 });
    expect(await f.json(await progressCall('GET', progressPaths[1]! + progressQuery), 200))
      .toMatchObject({ position: 'page:19', version: 1 });
    expect((await progressCall('GET', progressPaths[0]! + progressQuery, undefined,
      randomUUID(), f.account.tokenB)).status).toBe(404);
    const firstPage = await f.json<Page>(await f.call('GET', `${read}&limit=1`), 200);
    expect(firstPage.occurrences).toHaveLength(1);
    expect(firstPage.next).not.toBeNull();
    const secondPage = await f.json<Page>(await f.call('GET',
      `${read}&limit=1&after=${encodeURIComponent(firstPage.next!)}`), 200);
    expect(secondPage.occurrences[0]?.occurrence).toBe(changed.occurrences[1]);
    expect(secondPage.next).toBeNull();

    const move = { profile: 'book-composition', expectedHead: changed.revision,
      actingSubject: f.actor, operations: [{ op: 'move', occurrence: changed.occurrences[0],
        parent: created.structure, position: 'last' }] };
    const moved = await f.json<Changed>(await f.call('POST', `${path}/changes`, move), 200);
    expect((await f.json<Page>(await f.call('GET', read), 200)).occurrences
      .map(item => item.occurrence)).toEqual([...changed.occurrences].reverse());
    const repeatedSeal = await f.json<Created & { seal: string }>(await f.call('POST',
      `${path}/seals`, { expectedHead: moved.revision, actingSubject: f.actor }), 200);
    const principal = await f.account.verifier.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${f.account.tokenA}` } }), ['work:read']);
    const sealedPage = await readCompositionSeal(f.env, { structure: created.structure,
      seal: repeatedSeal.seal, limit: 100,
      canReadTarget: target => f.access.canReadWork(principal, f.actor, target) });
    const exported = await readExportPlan({ env: f.env, structureObjects: objects,
      canReadWork: (identity, actor, target) => f.access.canReadWork(identity, actor, target) },
    principal, f.actor, { kind: 'composition-seal', reference: repeatedSeal.seal,
      structure: created.structure, expectedPosition: sealedPage.sourcePosition }, 'evaluation');
    expect(new Set(exported.members.slice(1).map(member => member.exactRef)))
      .toEqual(new Set(changed.occurrences));
    expect(exported.members.slice(1).map(member => member.sourceGrain))
      .toEqual(['occurrence', 'occurrence']);
    expect(exported.members.slice(1).map(member => member.data?.target))
      .toEqual([work.work, work.work]);
    expect(new Set(exported.members.slice(1).map(member => member.sourcePosition)).size).toBe(2);
    expect(exported.work.members).toBe(3);
    expect((await f.call('POST', `${path}/changes`, move)).status).toBe(409);
    const prior = await f.json<Page>(await f.call('GET',
      `${path}/revisions/${shortId(changed.revision)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(prior.occurrences.map(item => item.occurrence)).toEqual(changed.occurrences);
    const exactPath = `${path}/revisions/${shortId(changed.revision)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const oldManifest = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?manifest WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(changed.revision)} rv:manifest ?manifest . } }`);
    const oldDigest = oldManifest.results!.bindings[0]!.manifest!.value.slice(-64);
    objectEnv.structureObjects = { put: bytes => objects.put(bytes), get: digest => digest === oldDigest
      ? Promise.reject(new ObjectUnavailable('missing staged object')) : objects.get(digest) };
    try { expect((await f.call('GET', exactPath)).status).toBe(503); }
    finally { objectEnv.structureObjects = objects; }
    objectEnv.structureObjects = { put: bytes => objects.put(bytes), get: digest => digest === oldDigest
      ? Promise.reject(new ObjectIntegrityError('corrupt staged object')) : objects.get(digest) };
    try { expect((await f.call('GET', exactPath)).status).toBe(503); }
    finally { objectEnv.structureObjects = objects; }
    const removed = await f.json<Changed>(await f.call('POST', `${path}/changes`,
      { profile: 'book-composition', expectedHead: moved.revision, actingSubject: f.actor,
        operations: [{ op: 'remove', occurrence: changed.occurrences[0] }] }), 200);
    expect((await f.json<Page>(await f.call('GET', read), 200)).occurrences
      .map(item => item.occurrence)).toEqual([changed.occurrences[1]]);
    expect(removed.revision).not.toBe(moved.revision);
    const occurrencePath = `${path}/occurrences/${shortId(changed.occurrences[0]!)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const tombstone = await f.json<Page>(await f.call('GET', occurrencePath), 200);
    expect(tombstone.occurrences[0]).toMatchObject({ occurrence: changed.occurrences[0],
      state: 'removed', parent: created.structure, sourceKey: 'source:/chapters/one' });
    expect(tombstone.occurrences[0]).not.toHaveProperty('orderKey');
    const former = await f.json<Page>(await f.call('GET',
      `${occurrencePath}&revision=${encodeURIComponent(changed.revision)}`), 200);
    expect(former.occurrences[0]).toMatchObject({ occurrence: changed.occurrences[0],
      state: 'active', target: work.work, sourceKey: 'source:/chapters/one' });
    expect(await f.json(await progressCall('GET', progressPaths[0]! + progressQuery), 200))
      .toMatchObject({ position: 'page:7', version: 1 });
    const groups = await f.json<Changed>(await f.call('POST', `${path}/changes`,
      { profile: 'book-composition', expectedHead: removed.revision, actingSubject: f.actor,
        operations: [
          { op: 'insert', parent: created.structure, position: 'last', role: 'group' },
          { op: 'insert', parent: created.structure, position: 'last', role: 'group' },
        ] }), 200);
    const [firstGroup, secondGroup] = groups.occurrences;
    const reparent = (occurrence: string, parent: string, expectedHead: string) => ({
      profile: 'book-composition', expectedHead, actingSubject: f.actor,
      operations: [{ op: 'move', occurrence, parent, position: 'last' }],
    });
    // Two writers move one chapter into different volumes on one head; exactly one wins.
    const races = await Promise.all([
      f.call('POST', `${path}/changes`, reparent(changed.occurrences[1]!, firstGroup!, groups.revision)),
      f.call('POST', `${path}/changes`, reparent(changed.occurrences[1]!, secondGroup!, groups.revision)),
    ]);
    expect(races.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = races[0]!.status === 200 ? 0 : 1;
    const winnerResult = await races[winner]!.json() as Changed;
    // A Book nests one group level, so a group never moves into another (nor into itself).
    for (const [child, parent] of [[secondGroup!, firstGroup!], [firstGroup!, firstGroup!]] as const) {
      const nested = await f.call('POST', `${path}/changes`, reparent(child, parent, winnerResult.revision));
      expect(nested.status).toBe(409);
    }
    const sealKey = `composition-${randomUUID()}`;
    const sealBody = { expectedHead: winnerResult.revision, actingSubject: f.actor };
    const sealed = await f.json<Created & { seal: string }>(await f.call('POST', `${path}/seals`,
      sealBody, sealKey), 200);
    expect(sealed.seal).toMatch(/^https:\/\/rezics\.com\/id\//);
    expect((await f.json<Created & { seal: string }>(await f.call('POST', `${path}/seals`,
      sealBody, sealKey), 200)).seal).toBe(sealed.seal);
    const sealGraph = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?manifest ?coverage ?unavailable WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(sealed.seal)} a rv:StructureSeal ; rv:manifest ?manifest ;
          rv:sealCoverage ?coverage ; rv:unavailableCount ?unavailable . } }`);
    const sealRow = sealGraph.results?.bindings[0];
    expect(sealRow?.coverage?.value).toBe('https://rezics.com/vocab/Partial');
    expect(sealRow?.unavailable?.value).toBe('1');
    const sealManifest = checkStructureSealManifest(await objects.get(sealRow!.manifest!.value.slice(-64)));
    expect(sealManifest.structureRevision).toBe(winnerResult.revision);
    expect(sealManifest.pins.count).toBe(1);
    const fixed = await f.json<{ structureRevision: string; pins: Array<{ occurrence: string;
      target?: string; unavailable?: string }> }>(await f.call('GET',
      `${path}/seals/${shortId(sealed.seal)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(fixed.structureRevision).toBe(winnerResult.revision);
    expect(fixed.pins).toEqual([{ occurrence: changed.occurrences[1], target: work.work,
      unavailable: 'missing' }]);
    let denseHead = winnerResult.revision;
    let rebalanced = 0;
    for (let batch = 0; batch < 32; batch++) {
      const denseResponse = await f.call('POST', `${path}/changes`, {
        profile: 'book-composition', expectedHead: denseHead, actingSubject: f.actor,
        operations: Array.from({ length: 16 }, () => ({ op: 'insert', parent: created.structure,
          position: 'last', role: 'group' })),
      });
      if (denseResponse.status !== 200) throw new Error(`dense batch ${batch}: ${denseResponse.status} ${await denseResponse.text()}`);
      const dense = await f.json<Changed>(denseResponse, 200);
      denseHead = dense.revision;
      rebalanced += dense.cost.rebalanced;
      expect(dense.cost.rebalanced).toBeLessThanOrEqual(64);
      expect(dense.cost.placementsWritten).toBeLessThanOrEqual(64);
    }
    expect(rebalanced).toBeGreaterThan(0);
    expect((await f.json<Page>(await f.call('GET', read), 200)).placementCount).toBe(515);
    const retained: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await f.json<Page>(await f.call('GET', `${read}&limit=100${cursor
        ? `&after=${encodeURIComponent(cursor)}` : ''}`), 200);
      retained.push(...page.occurrences.map(item => item.occurrence));
      cursor = page.next;
    } while (cursor);
    expect(retained).toHaveLength(514);
    expect(new Set(retained).size).toBe(retained.length);
    expect(retained).toEqual(expect.arrayContaining([firstGroup, secondGroup]));
    const volume = winner === 0 ? firstGroup! : secondGroup!;
    expect((await f.json<Page>(await f.call('GET', `${read}&parent=${encodeURIComponent(volume)}`), 200))
      .occurrences.map(item => item.occurrence)).toEqual([changed.occurrences[1]]);
    const restored = await f.json<Changed>(await f.call('POST', `${path}/restorations`, {
      expectedHead: denseHead, restoredFrom: changed.revision, actingSubject: f.actor }), 200);
    expect(restored.revision).not.toBe(changed.revision);
    expect((await f.json<Page>(await f.call('GET', read), 200)).occurrences
      .map(item => item.occurrence)).toEqual(changed.occurrences);
    const catalogTarget = 'https://schema.org/Book';
    const catalogChange = await f.json<Changed>(await f.call('POST', `${path}/changes`, {
      profile: 'book-composition', expectedHead: restored.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', parent: created.structure, position: 'last', role: 'chapter',
        target: catalogTarget }],
    }), 200);
    const catalogPage = await f.json<Page>(await f.call('GET', read), 200);
    expect(catalogPage.occurrences.at(-1)).toMatchObject({
      occurrence: catalogChange.occurrences[0], target: catalogTarget,
    });
    expect(catalogPage.occurrences.at(-1)).not.toHaveProperty('selection');
    expect((await f.json<Page>(await f.call('GET',
      `${path}/revisions/${shortId(denseHead)}?actingSubject=${encodeURIComponent(f.actor)}&limit=100`),
    200)).placementCount).toBe(515);
    expect((await f.call('POST', `${path}/restorations`, {
      expectedHead: denseHead, restoredFrom: changed.revision, actingSubject: f.actor })).status).toBe(409);
  } finally { await f.close(); }
}, 180_000);
