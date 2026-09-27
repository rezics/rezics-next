import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { StructureStageStore } from '../../../services/main/src/modules/structure/stage.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

test('BOOK07: exact source import and three-way refresh preserve local edits or report conflict', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structure-refresh-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
    access: f.access, structureObjects: objects,
    structureStages: new StructureStageStore(f.pool, objects) });
  const call = (method: string, path: string, body?: object, key = randomUUID(),
    token = f.account.tokenA) => app.handle(
    new Request(`http://main.local${path}`, { method, headers: {
      authorization: `Bearer ${token}`, 'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  try {
    const createBook = async (title: string) => json<{ work: string; mainVersion: string }>(
      await call('POST', '/v1/works', { profile: 'metadata-only-v1', title,
        semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor }), 201);
    const source = await createBook('Imported source Book');
    const target = await createBook('Local edited Book');
    let sourceReadGrant = '';
    for (const work of [source.work, target.work]) {
      await f.grant(`work:edit:${work}`, 'work.edit');
      const grant = await f.grant(`work:read:${work}`, 'work.read');
      if (work === source.work) sourceReadGrant = grant;
    }
    const createStructure = async (book: typeof source) => json<{ structure: string;
      revision: string }>(await call('POST', '/v1/compositions', { profile: 'book-composition',
      work: book.work, mainVersion: book.mainVersion, actingSubject: f.actor }), 201);
    const origin = await createStructure(source);
    const destination = await createStructure(target);
    const sourcePath = `/v1/compositions/${shortId(origin.structure)}`;
    const destPath = `/v1/compositions/${shortId(destination.structure)}`;
    const chapter = (parent: string, sourceKey: string) => ({ op: 'insert', parent,
      position: 'last', role: 'chapter', target: source.work, sourceKey });
    const sourceFirst = await json<{ revision: string; occurrences: string[] }>(await call('POST',
      `${sourcePath}/changes`, { profile: 'book-composition', expectedHead: origin.revision,
        actingSubject: f.actor, operations: [chapter(origin.structure, 'A'),
          chapter(origin.structure, 'B')] }), 200);
    const refresh = (expectedHead: string, sourceRevision: string) => ({ expectedHead,
      sourceStructure: origin.structure, sourceRevision, actingSubject: f.actor });
    const importKey = `refresh-${randomUUID()}`;
    expect((await call('POST', `${destPath}/refreshes`,
      refresh(destination.revision, sourceFirst.revision), randomUUID(), f.account.noScope)).status)
      .toBe(401);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [sourceReadGrant]);
    expect((await call('POST', `${destPath}/refreshes`,
      refresh(destination.revision, sourceFirst.revision))).status).toBe(404);
    await f.accessPool.query('UPDATE access.permission_grant SET active = true WHERE id = $1',
      [sourceReadGrant]);
    const imported = await json<{ revision: string; kind: string; graphReceipt: string;
      cost: { placementsWritten: number } }>(await call('POST', `${destPath}/refreshes`,
      refresh(destination.revision, sourceFirst.revision), importKey), 200);
    expect(imported).toMatchObject({ kind: 'import', cost: { placementsWritten: 2 } });
    expect(imported.graphReceipt).toMatch(/^urn:rezics:receipt:/);
    expect(await json<{ revision: string }>(await call('POST', `${destPath}/refreshes`,
      refresh(destination.revision, sourceFirst.revision), importKey), 200))
      .toMatchObject({ revision: imported.revision });
    expect((await call('POST', `${destPath}/refreshes`,
      refresh(destination.revision, sourceFirst.revision))).status).toBe(409);
    const read = async (path: string) => json<{ revision: string; occurrences: Array<{
      occurrence: string; sourceKey?: string; target?: string }> }>(await call('GET',
      `${path}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    const first = await read(destPath);
    expect(first.occurrences).toHaveLength(2);
    expect(first.occurrences.map(item => item.target)).toEqual([source.work, source.work]);
    expect(new Set(first.occurrences.map(item => item.occurrence)).size).toBe(2);
    const importedItems = await f.env.fuseki.query(`PREFIX schema: <https://schema.org/>
      PREFIX rv: <https://rezics.com/vocab/> SELECT ?item ?target WHERE {
        GRAPH ${iri(GRAPHS.current)} {
          VALUES ?item { ${first.occurrences.map(item => iri(item.occurrence)).join(' ')} }
          ?item a schema:ListItem .
          ${iri(destination.structure)} rv:selectedGeneration ?generation .
          ?placement rv:occurrence ?item ; rv:generation ?generation ; schema:item ?target .
        } }`);
    expect(importedItems.results?.bindings).toHaveLength(2);
    expect(importedItems.results!.bindings.map(row => row.target!.value))
      .toEqual([source.work, source.work]);
    const localMove = await json<{ revision: string }>(await call('POST', `${destPath}/changes`, {
      profile: 'book-composition', expectedHead: imported.revision, actingSubject: f.actor,
      operations: [{ op: 'move', occurrence: first.occurrences[0]!.occurrence,
        parent: destination.structure, position: 'last' }],
    }), 200);
    const sourceSecond = await json<{ revision: string; occurrences: string[] }>(await call('POST',
      `${sourcePath}/changes`, { profile: 'book-composition', expectedHead: sourceFirst.revision,
        actingSubject: f.actor, operations: [chapter(origin.structure, 'C')] }), 200);
    const originalFuseki = f.env.fuseki;
    let lostResponse = false;
    f.env.fuseki = new Proxy(originalFuseki, { get(object, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const outcome = await object.commandWithReceipt(envelope);
        if (!lostResponse && envelope.update.includes('composition.stage-activate')) {
          lostResponse = true;
          throw new Error('lost refresh activation response');
        }
        return outcome;
      };
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    const refreshKey = `refresh-${randomUUID()}`;
    let refreshed: { revision: string; kind: string };
    try {
      refreshed = await json(await call('POST', `${destPath}/refreshes`,
        refresh(localMove.revision, sourceSecond.revision), refreshKey), 200);
      expect(lostResponse).toBe(true);
    } finally { f.env.fuseki = originalFuseki; }
    expect(refreshed.kind).toBe('refresh');
    expect(await json<{ revision: string }>(await call('POST', `${destPath}/refreshes`,
      refresh(localMove.revision, sourceSecond.revision), refreshKey), 200))
      .toMatchObject({ revision: refreshed.revision });
    const provenance = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?source ?basis ?operation WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(refreshed.revision)} rv:importSource ?source ;
          rv:importSourceRevision ?basis ; rv:structureOperation ?operation . } }`);
    expect(provenance.results?.bindings[0]).toMatchObject({
      source: { value: origin.structure }, basis: { value: sourceSecond.revision },
      operation: { value: 'https://rezics.com/vocab/StructureRefresh' },
    });
    const merged = await read(destPath);
    expect(merged.occurrences.slice(0, 2).map(item => item.occurrence))
      .toEqual([...first.occurrences.map(item => item.occurrence)].reverse());
    expect(merged.occurrences[2]?.occurrence).not.toBe(sourceSecond.occurrences[0]);
    expect((await json<{ occurrences: Array<{ occurrence: string }> }>(await call('GET',
      `${destPath}/revisions/${shortId(imported.revision)}?actingSubject=${encodeURIComponent(f.actor)}`),
    200)).occurrences.map(item => item.occurrence))
      .toEqual(first.occurrences.map(item => item.occurrence));
    const sourceThird = await json<{ revision: string }>(await call('POST', `${sourcePath}/changes`, {
      profile: 'book-composition', expectedHead: sourceSecond.revision, actingSubject: f.actor,
      operations: [{ op: 'move', occurrence: sourceFirst.occurrences[1],
        parent: origin.structure, position: 'last' }],
    }), 200);
    const localThird = await json<{ revision: string }>(await call('POST', `${destPath}/changes`, {
      profile: 'book-composition', expectedHead: refreshed.revision, actingSubject: f.actor,
      operations: [{ op: 'move', occurrence: merged.occurrences[2]!.occurrence,
        parent: destination.structure, position: 'first' }],
    }), 200);
    const conflict = await json<{ code: string; conflicts: Array<{ reason: string }> }>(
      await call('POST', `${destPath}/refreshes`,
        refresh(localThird.revision, sourceThird.revision)), 409);
    expect(conflict.code).toBe('structure_refresh_conflict');
    expect(conflict.conflicts).toContainEqual(expect.objectContaining({
      reason: 'local-and-source-order' }));
    expect((await read(destPath)).revision).toBe(localThird.revision);
  } finally { await f.close(); }
}, 180_000);
