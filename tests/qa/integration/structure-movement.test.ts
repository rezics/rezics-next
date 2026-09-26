import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { ObjectUnavailable, S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { captureObjectRecoveryCoverage } from '../../../services/main/src/modules/owner/object-coverage.ts';
import { readCompositionPage } from '../../../services/main/src/modules/structure/read.ts';
import { checkStructureManifest } from '../../../services/main/src/modules/structure/format.ts';

test('COMP07: relocation coverage includes retained Structure roots, pages and seal pins', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structure-movement-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const book = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Retained moving book',
      semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor,
    }), 201);
    await f.grant(`work:edit:${book.work}`, 'work.edit');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'book-composition', work: book.work,
        mainVersion: book.mainVersion, actingSubject: f.actor }), 201);
    const path = `/v1/compositions/${shortId(created.structure)}`;
    const changed = await f.json<{ revision: string }>(await f.call('POST', `${path}/changes`, {
      profile: 'book-composition', expectedHead: created.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', parent: created.structure, role: 'group', position: 'last' }],
    }), 200);
    await f.json(await f.call('POST', `${path}/seals`,
      { expectedHead: changed.revision, actingSubject: f.actor }), 200);
    const store = { directory: f.env.objectDirectory, structureObjects: objects };
    const source = await captureObjectRecoveryCoverage(f.env.fuseki, store);
    expect(Number(source.anchorCount)).toBeGreaterThanOrEqual(3);
    expect(Number(source.objectCount)).toBeGreaterThanOrEqual(5);
    const query = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?manifest WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(changed.revision)} rv:manifest ?manifest . } }`);
    const rootDigest = query.results!.bindings[0]!.manifest!.value.slice(-64);
    const root = checkStructureManifest(await objects.get(rootDigest));
    const lostPage = root.records.page.slice(7);
    const missing: ImmutableObjects = { put: bytes => objects.put(bytes),
      get: digest => digest === lostPage
        ? Promise.reject(new ObjectUnavailable('retained page was not copied')) : objects.get(digest) };
    await expect(captureObjectRecoveryCoverage(f.env.fuseki,
      { ...store, structureObjects: missing })).rejects.toThrow('unavailable');
    const target = await captureObjectRecoveryCoverage(f.env.fuseki, store);
    expect(target).toEqual(source);
    expect((await readCompositionPage(f.env, { structure: created.structure,
      revision: changed.revision, limit: 10, canReadTarget: async () => true })).occurrences)
      .toHaveLength(1);
  } finally { await f.close(); }
});
