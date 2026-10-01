import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';

test('Collection names publish a replayable localized revision over a legacy label', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `collection-name-${randomUUID()}`),
    'openid work:create work:edit collection:edit semantic:read');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    const path = `/v1/collections/${shortId(collection)}/name`;
    await f.json(await f.call('POST', '/v1/collections', { collection,
      name: 'Classics to start with · 从这里开始读经典', disclosure: 'public', actingSubject: f.actor }), 201);
    expect(await f.json(await f.call('GET', path), 200)).toMatchObject({ revision: null,
      name: { original: 'und', labels: { und: 'Classics to start with · 从这里开始读经典' } } });
    const body = { profile: 'collection-public-name-v1', expectedHead: null, actingSubject: f.actor,
      name: { original: 'en', labels: { en: 'Classics to start with', 'zh-Hans': '从这里开始读经典' } } };
    const key = `collection-name-${randomUUID()}`;
    const written = await f.json<{ revision: string; replayed: boolean; receipt: string;
      sourcePosition: { dataEpoch: string; sequence: string } }>(
      await f.call('PUT', path, body, key), 201);
    expect(written.replayed).toBe(false);
    expect(await f.json(await f.call('PUT', path, body, key), 200))
      .toMatchObject({ revision: written.revision, replayed: true });
    expect((await f.call('PUT', path, body, `collection-name-${randomUUID()}`)).status).toBe(409);
    expect((await f.call('PUT', path, { ...body, name: { original: 'de', labels: { en: 'Classics' } } },
      `collection-name-${randomUUID()}`)).status).toBe(400);
    expect(await f.json(await f.call('GET', path), 200)).toMatchObject({ revision: written.revision,
      name: body.name });
    const graph = (await f.env.fuseki.query(`PREFIX schema: <https://schema.org/> SELECT ?name WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} schema:name ?name } }`)).results?.bindings ?? [];
    expect(graph.map(row => row.name?.value)).toEqual(['Classics to start with']);
    const eventId = `urn:rezics:event:${hash((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?operation WHERE { GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(written.receipt)} rv:operation ?operation } }`)).results!.bindings[0]!.operation!.value)}`;
    const event = await readMainOutboxEnvelope(f.env.fuseki, {
      batchId: `urn:rezics:outbox:${hash(written.receipt)}`, eventIds: [eventId],
      dataEpoch: written.sourcePosition.dataEpoch, sequence: written.sourcePosition.sequence,
      routingEpoch: f.env.lineage.routingEpoch,
    }, eventId);
    expect(event).toMatchObject({ type: 'com.rezics.collection.name-published.v1',
      data: { receipt: { action: 'collection.edit', collection, revision: written.revision } } });
  } finally { await f.close(); }
}, 120_000);
