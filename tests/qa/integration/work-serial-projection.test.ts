import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startMediaStack } from './media-support.ts';
import { SerialStatisticsProjection } from '../../../services/main/src/modules/work/serial-projection.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('G291: Structure membership and Content text relay into restore-fenced serial facts', async () => {
  const stack = await startMediaStack('serial-projection');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL! });
  try {
    const epoch = stack.env.lineage.dataEpoch;
    const structure = id(), work = id(), resource = id(), occurrence = id();
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const revision = `urn:rezics:content:revision:${randomUUID()}`;
    const nextRevision = `urn:rezics:content:revision:${randomUUID()}`;
    let currentRevision = revision;
    const unit = `urn:rezics:content:match-unit:${randomUUID().replaceAll('-', '')}`;
    const env = { ...stack.env, fuseki: { query: async (sparql: string) => sparql.includes('rv:searchBody')
      ? { results: { bindings: [{ body: { type: 'literal', value: 'Two short sentences.' } }] } }
      : { results: { bindings: [{ work: { type: 'uri', value: work },
        occurrence: { type: 'uri', value: occurrence }, chapter: { type: 'uri', value: resource },
        variant: { type: 'uri', value: variant }, revision: { type: 'uri', value: currentRevision } }] } } },
    } as unknown as WorkActivationEnvironment;
    const stableTime = new Date('2026-09-01T12:00:00.000Z');
    const source = { query: async () => ({ rows: [{ created_at: stableTime }] }) } as unknown as Pool;
    const projection = new SerialStatisticsProjection(stack.accessPool, relay, source, env);
    const insert = async (sequence: number, type: string, receipt: Record<string, unknown>) => {
      await relay.query(`INSERT INTO relay.delivered_batch
        (data_epoch, sequence, batch_id, routing_epoch, event_count) VALUES ($1,$2,$3,$4,1)`,
      [epoch, sequence, `urn:rezics:outbox:${randomUUID()}`, env.lineage.routingEpoch]);
      await relay.query(`INSERT INTO relay.delivered_event
        (source, event_id, data_epoch, sequence, envelope) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      ['https://rezics.com/services/main', `urn:rezics:event:${randomUUID()}`, epoch, sequence,
        JSON.stringify({ type, data: { receipt } })]);
    };
    await insert(1, 'com.rezics.structure.projected.v1', {
      action: 'structure.project', outcome: 'succeeded', structure, stageId: randomUUID() });
    expect(await projection.tick()).toBe(1);
    expect((await projection.batch([work])).get(work)).toMatchObject({ chapterCount: 1, wordCount: null });
    await insert(2, 'com.rezics.content.projected.v1', {
      action: 'content.project', outcome: 'succeeded', resource, variant,
      contentRevision: revision, matchUnit: unit, ownerDataEpoch: randomUUID(), ownerSequence: '1' });
    expect(await projection.tick()).toBe(1);
    const facts = (await projection.batch([work])).get(work);
    expect(facts).toMatchObject({ chapterCount: 1, wordCount: 3 });
    expect(facts?.lastUpdatedAt).toBe(stableTime.toISOString());
    currentRevision = nextRevision;
    await insert(3, 'com.rezics.content.published.v1', {
      action: 'content.publish', outcome: 'succeeded', resource, variant, contentRevision: nextRevision });
    expect(await projection.tick()).toBe(1);
    expect((await projection.batch([work])).get(work)).toMatchObject({ chapterCount: 1, wordCount: null });
    await insert(4, 'com.rezics.content.projected.v1', {
      action: 'content.project', outcome: 'succeeded', resource, variant,
      contentRevision: nextRevision, matchUnit: unit,
      ownerDataEpoch: randomUUID(), ownerSequence: '2' });
    expect(await projection.tick()).toBe(1);
    expect((await projection.batch([work])).get(work)).toMatchObject({ chapterCount: 1, wordCount: 3 });
    expect(await projection.tick()).toBe(0);

    const restored = new SerialStatisticsProjection(stack.accessPool, relay, source,
      { ...env, lineage: { ...env.lineage, dataEpoch: randomUUID() } });
    expect(await restored.tick()).toBe(0);
    expect((await restored.batch([work])).has(work)).toBe(false);
  } finally { await relay.end(); await stack.stop(); }
});

test('G291: public serial count excludes a private Structure chapter', async () => {
  const stack = await startMediaStack('serial-public-count');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL! });
  try {
    const editor = await stack.member('serial-editor');
    const parent = await stack.publicWork(editor.actor, ['en'], 'Public serial');
    const child = await stack.publicWork(editor.actor, ['en'], 'Public chapter');
    const structure = id(), generation = `urn:rezics:generation:${randomUUID()}`;
    const publicOccurrence = id(), privateOccurrence = id(), hidden = id();
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(structure)} a rv:Structure ; rv:structureOf ${iri(parent.mainVersion)} ;
          rv:selectedGeneration ${iri(generation)} .
        ${iri(generation)} rv:generationState rv:Active .
        <urn:rezics:placement:${randomUUID()}> a rv:OccurrencePlacement ;
          rv:generation ${iri(generation)} ; rv:occurrence ${iri(publicOccurrence)} ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ${iri(child.work)} .
        <urn:rezics:placement:${randomUUID()}> a rv:OccurrencePlacement ;
          rv:generation ${iri(generation)} ; rv:occurrence ${iri(privateOccurrence)} ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ${iri(hidden)} . } }`);
    const epoch = stack.env.lineage.dataEpoch;
    const sequence = Number((await relay.query<{ sequence: string }>(
      `SELECT coalesce(max(sequence),0)::text AS sequence FROM relay.delivered_batch
       WHERE data_epoch = $1`, [epoch])).rows[0]!.sequence) + 1;
    await relay.query(`INSERT INTO relay.delivered_batch
      (data_epoch, sequence, batch_id, routing_epoch, event_count) VALUES ($1,$2,$3,$4,1)`,
    [epoch, sequence, `urn:rezics:outbox:${randomUUID()}`, stack.env.lineage.routingEpoch]);
    await relay.query(`INSERT INTO relay.delivered_event
      (source, event_id, data_epoch, sequence, envelope) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    ['https://rezics.com/services/main', `urn:rezics:event:${randomUUID()}`, epoch, sequence,
      JSON.stringify({ type: 'com.rezics.structure.projected.v1', data: { receipt: {
        action: 'structure.project', outcome: 'succeeded', structure, stageId: randomUUID(),
      } } })]);
    const source = { query: async () => ({ rows: [{ created_at: new Date('2026-09-01T00:00:00Z') }] }) } as unknown as Pool;
    const projection = new SerialStatisticsProjection(stack.accessPool, relay, source, stack.env);
    for (let i = 0; i <= sequence && await projection.tick(); i++) { /* replay the retained relay cut */ }
    expect((await projection.batch([parent.work])).get(parent.work))
      .toMatchObject({ chapterCount: 1, wordCount: null });
  } finally { await relay.end(); await stack.stop(); }
});
