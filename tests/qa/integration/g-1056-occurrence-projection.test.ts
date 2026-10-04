import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { backfillOccurrenceLabels, occurrenceLabelReadiness, projectOccurrenceLabelsOnce,
  type OccurrenceLabelProgress } from '../../../services/main/src/modules/structure/label-index-backfill.ts';
import { OccurrenceLabelWorker } from '../../../services/main/src/modules/structure/label-index-worker.ts';
import { activateMetadataWork, DATASET, GRAPHS, hash, iri, lit, metadataWorkRequestDigest, PUBLIC_SEARCH_ANCHOR, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

const state = iri('urn:rezics:graph:occurrence-search-state');
async function json<T>(response: Response, expected = 200): Promise<T> {
  if (response.status !== expected) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G1056: retained initialization receipts cannot strand rebuilt labels or starve other generations', async () => {
  const stack = await startMediaStack('g-1056-occurrence-projection');
  try {
    const editor = await stack.member('projection-editor');
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      media: stack.media, mediaAccess: stack.mediaAccess, structureObjects: objects,
      readingPositions: new ReadingPositionStore(stack.contentPool),
      account: { verify: async () => editor.principal } });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(method === 'POST' ? { authorization: `Bearer ${editor.token}` } : {}), 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    type Composition = { structure: string; revision: string };
    const createComposition = async (title: string) => {
      const semanticTypes = ['https://schema.org/Book'];
      const work = await activateMetadataWork(stack.env, { title, semanticTypes,
        admission: stack.admission(editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
      const text = await stack.contribution(work.work, editor.actor, 'en', title);
      const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
        contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
      await selectMainDefault(stack.env, stack.admission(editor.actor, `publication:select:${work.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await editor.grant(`work:edit:${work.work}`, 'work.edit');
      await editor.grant(`work:read:${work.work}`, 'work.read');
      let composition = await json<Composition>(await call('POST', '/v1/compositions', {
        profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: editor.actor,
      }), 201);
      composition = await json<Composition>(await call('POST', `/v1/compositions/${composition.structure.slice(-36)}/changes`, {
        profile: 'book-composition', expectedHead: composition.revision, actingSubject: editor.actor,
        operations: [{ op: 'insert', role: 'chapter', parent: composition.structure, position: 'last',
          target: 'https://schema.org/DigitalDocument', label: { value: '重逢', language: 'yue' } }],
      }));
      const generation = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?generation WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(composition.structure)} rv:selectedGeneration ?generation } } LIMIT 1`))
        .results!.bindings[0]!.generation!.value;
      return { work, composition, generation };
    };
    const { work, composition, generation } = await createComposition('Projection recovery');
    const other = await createComposition('Another pending generation');
    const descriptor = async () => {
      const row = (await stack.fuseki.query(`PREFIX rv: <${RV}>
        SELECT ?checkpoint ?build ?targetText ?textGeneration WHERE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexGeneration ?textGeneration }
          GRAPH ${state} { ${iri(generation)} rv:indexBatch ?checkpoint ; rv:indexBuild ?build ; rv:targetTextGeneration ?targetText }
        } LIMIT 2`)).results!.bindings;
      expect(row).toHaveLength(1);
      return Object.fromEntries(Object.entries(row[0]!).map(([key, value]) => [key, value.value])) as {
        checkpoint: string; build: string; targetText: string; textGeneration: string };
    };
    await backfillOccurrenceLabels(stack.env);
    const before = await descriptor();
    expect(before.checkpoint).toBe('1');

    // A rebuild/restore changes this durable control identity while retaining
    // Structure descriptors and historical receipts. Use the native maintenance
    // transaction on this isolated QA stack to reproduce that exact boundary.
    const rotate = async () => {
      const next = `urn:rezics:text-index-generation:${randomUUID()}`, digest = hash(next);
      const cut = await stack.content.ownerPosition();
      for (const phase of ['quarantine', 'activate'] as const) {
        const receipt = `urn:rezics:receipt:content-rebuild:${phase}:${digest}`;
        const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`, event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
        const anchor = `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor }`;
        const result = await stack.fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 60_000,
          update: `PREFIX rv: <${RV}>
            DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n ${phase === 'activate' ? '; rv:textIndexGeneration ?old' : ''} }
              ${phase === 'quarantine' ? anchor : ''} }
            INSERT {
              GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next ${phase === 'activate' ? `; rv:textIndexGeneration ${iri(next)}` : ''} }
              ${phase === 'activate' ? anchor : ''}
              GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
                rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ; rv:sequence ?next
                ${phase === 'activate' ? `; rv:ownerDataEpoch ${lit(cut.dataEpoch)} ; rv:ownerSequence ${cut.sequence} ;
                  rv:priorIndexGeneration ?old ; rv:textIndexGeneration ${iri(next)} ; rv:indexRebuildDigest ${lit(digest)}` : ''} }
              GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
                rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
                ${iri(event)} a rv:ContentRebuildEvent ; rv:ordinal 0 ; rv:receipt ${iri(receipt)} ; rv:action ${lit(`content.rebuild.${phase}`)} }
            } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ;
                rv:routingEpoch ${lit(stack.env.lineage.routingEpoch)} ; rv:sequence ?n ; rv:textIndexGeneration ?old }
              BIND(?n + 1 AS ?next) }` });
        if (result.status !== 'committed') throw new Error(`generation fixture rotation: ${JSON.stringify(result)}`);
      }
      return next;
    };
    const nextText = await rotate();
    const legacyDigest = hash(JSON.stringify({ family: 'occurrence-lucene-v1', generation,
      revision: composition.revision, checkpoint: before.checkpoint, build: before.build, textGeneration: nextText }));
    const legacyReceipt = `urn:rezics:receipt:chapter-search-index:${legacyDigest}`;
    const legacy: CommandEnvelope = { receipt: legacyReceipt, digest: legacyDigest, validations: [], deadlineMs: 60_000,
      update: `PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(legacyReceipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(legacyDigest)} ;
            rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ;
            rv:sequence ?next ; rv:occurrenceSearchGeneration ${iri(generation)} }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${legacyDigest}`)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 }
        } WHERE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(stack.env.lineage.routingEpoch)} ; rv:sequence ?n ; rv:textIndexGeneration ${iri(nextText)} }
          GRAPH ${iri(GRAPHS.current)} { ${iri(composition.structure)} rv:structureHead ${iri(composition.revision)} }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(legacyReceipt)} ?p ?o } }
          BIND(?n + 1 AS ?next) }` };
    expect((await stack.fuseki.commandWithReceipt(legacy)).status).toBe('committed');
    expect((await descriptor()).checkpoint).toBe('0');
    await projectOccurrenceLabelsOnce(stack.env, { generation }); // bounded clear -> batch 1
    expect((await descriptor()).checkpoint).toBe('1');
    const collision = await descriptor();
    expect(hash(JSON.stringify({ family: 'occurrence-lucene-v1', generation, revision: composition.revision,
      checkpoint: collision.checkpoint, build: collision.build, textGeneration: collision.textGeneration }))).toBe(legacyDigest);
    expect((await stack.fuseki.commandWithReceipt(legacy)).status).toBe('committed');
    expect((await descriptor()).checkpoint).toBe('1');
    expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(legacyReceipt)} rv:occurrenceProjectedCount ?count } }`)).boolean).toBe(false);
    await expect(projectOccurrenceLabelsOnce({ ...stack.env, lineage: {
      ...stack.env.lineage, routingEpoch: randomUUID(),
    } }, { generation })).rejects.toThrow('guard rejected an unchanged checkpoint');

    const progress: OccurrenceLabelProgress[] = [];
    // New process/client resumes the retained cursor and bypasses the v1 receipt.
    const resumed = { ...stack.env, fuseki: new FusekiClient(Bun.env.FUSEKI_URL!) };
    expect(await backfillOccurrenceLabels(resumed, { onProgress: item => progress.push(item) })).toMatchObject({ indexed: 2 });
    expect(progress.find(item => item.generation === generation)).toMatchObject({
      action: 'project', checkpoint: '1', nextCheckpoint: '2', projected: 1,
    });
    expect(progress.some(item => item.generation === other.generation && item.projected === 1)).toBe(true);
    expect(await occurrenceLabelReadiness(resumed)).toMatchObject({ status: 'current' });
    const chooser = async () => json<{ items: unknown[]; search: { status: string } }>(await call('GET',
      `/v1/reading-positions/${work.work.slice(-36)}?q=重逢&limit=1`));
    expect(await chooser()).toMatchObject({ search: { status: 'current' } });
    expect((await chooser()).items).toHaveLength(1);

    // Another rebuild, followed by a lost committed initialization reply and a
    // worker restart, must drain every pending generation through the real loop.
    await rotate();
    const command = resumed.fuseki.commandWithReceipt.bind(resumed.fuseki);
    resumed.fuseki.commandWithReceipt = async request => { await command(request); throw new Error('G1056 lost reply'); };
    try { await expect(projectOccurrenceLabelsOnce(resumed, { generation })).rejects.toThrow('G1056 lost reply'); }
    finally { resumed.fuseki.commandWithReceipt = command; }
    const worker = new OccurrenceLabelWorker(resumed, 5);
    worker.start();
    try {
      for (let attempt = 0; attempt < 200 && (await occurrenceLabelReadiness(resumed)).status === 'indexing'; attempt++)
        await Bun.sleep(10);
      expect(await occurrenceLabelReadiness(resumed)).toMatchObject({ status: 'current' });
      expect((await chooser()).items).toHaveLength(1);
      expect(await json(await call('GET', '/health/search-ready'))).toMatchObject({
        status: 'ready', occurrenceLabels: { status: 'current' },
      });
    } finally { await worker.stop(); }
  } finally { await stack.stop(); }
}, 120_000);
