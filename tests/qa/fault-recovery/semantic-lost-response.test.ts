import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ownerOutboxEventHandler } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { initializeRelayCheckpoint, readMainOutboxEnvelope, readNextMainOutboxBatch, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';

test('MODEL01/MODEL14: a lost semantic graph acknowledgement resolves one receipt and event', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `semantic-lost-response-${randomUUID()}`));
  const original = f.env.fuseki;
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    let lost = false;
    f.env.fuseki = new Proxy(original, { get(target, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const result = await target.commandWithReceipt(envelope);
        if (!lost && envelope.update.includes('rv:SemanticChangedEvent')) {
          lost = true;
          throw new Error('lost semantic graph acknowledgement');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const key = randomUUID();
    const body = { profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor,
      state: { component: 'resource', types: ['https://schema.org/Person', 'https://schema.org/Patient'],
        properties: [] } };
    const first = await f.json<{ component: string; revision: string; receipt: string; replayed: boolean }>(
      await f.call('POST', '/v1/semantic/changes', body, key), 201);
    expect(lost).toBe(true);
    expect(first.replayed).toBe(false);
    const replay = await f.json<typeof first>(await f.call('POST', '/v1/semantic/changes', body, key), 201);
    expect(replay).toMatchObject({ component: first.component, revision: first.revision,
      receipt: first.receipt, replayed: true });
    const generation = await readNextMainOutboxBatch(original, f.env.lineage.dataEpoch, '0');
    expect(generation?.eventIds).toHaveLength(1);
    const generationReceipt = await original.query(`PREFIX rv: <${RV}> SELECT ?receipt ?digest ?operation WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(generation!.eventIds[0]!)} rv:receipt ?receipt }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:requestDigest ?digest ; rv:operation ?operation }
    }`);
    expect(generationReceipt.results?.bindings).toHaveLength(1);
    const systemHandler = ownerOutboxEventHandler(`${RV}ModelGenerationRecordedEvent`);
    expect(systemHandler?.authority).toBe('system');
    const values: Record<string, string | undefined> = {
      receipt: generationReceipt.results!.bindings[0]!.receipt!.value,
      digest: generationReceipt.results!.bindings[0]!.digest!.value,
      operation: generationReceipt.results!.bindings[0]!.operation!.value,
      outcome: `${RV}Succeeded`, epoch: f.env.lineage.dataEpoch, sequence: generation!.sequence,
    };
    const proved = await systemHandler!.read({ fuseki: original, batch: generation!,
      eventId: generation!.eventIds[0]!, value: key => values[key], ordinal: 0 });
    expect(proved.data.receipt).toMatchObject({ action: 'model.generation.record',
      systemProof: { kind: 'model-generation-v1', generationNumber: '1' } });
    const generationEvent = await readMainOutboxEnvelope(original, generation!, generation!.eventIds[0]!);
    expect(generationEvent).toMatchObject({ type: 'com.rezics.model.generation-recorded.v1',
      data: { receipt: { action: 'model.generation.record', outcome: 'succeeded',
        systemProof: { kind: 'model-generation-v1', generationNumber: '1' } } } });
    const change = await readNextMainOutboxBatch(original, f.env.lineage.dataEpoch, generation!.sequence);
    expect(change?.eventIds).toHaveLength(1);
    const event = await readMainOutboxEnvelope(original, change!, change!.eventIds[0]!);
    expect(event.data.receipt).toMatchObject({ id: first.receipt, action: 'semantic.change',
      outcome: 'succeeded', component: first.component, revision: first.revision });
    expect(await readNextMainOutboxBatch(original, f.env.lineage.dataEpoch, change!.sequence)).toBeNull();
    const consumer = `semantic-generation:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);
    expect((await relayMainOutboxOnce(original, relay, consumer))?.sequence).toBe(generation!.sequence);
    expect((await relayMainOutboxOnce(original, relay, consumer))?.sequence).toBe(change!.sequence);
    expect(await relayMainOutboxOnce(original, relay, consumer)).toBeNull();
    const delivered = await relay.query<{ event_id: string; envelope: typeof generationEvent }>(
      'SELECT event_id, envelope FROM relay.delivered_event WHERE data_epoch = $1 ORDER BY sequence',
      [f.env.lineage.dataEpoch]);
    expect(delivered.rows).toHaveLength(2);
    expect(delivered.rows[0]).toMatchObject({ event_id: generation!.eventIds[0],
      envelope: { type: 'com.rezics.model.generation-recorded.v1', data: { receipt: {
        systemProof: { kind: 'model-generation-v1' } } } } });
    expect(delivered.rows[1]).toMatchObject({ event_id: change!.eventIds[0],
      envelope: { type: 'com.rezics.semantic.changed.v1' } });
    const checkpoint = await relay.query<{ sequence: string }>(
      'SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', [consumer]);
    expect(checkpoint.rows[0]?.sequence).toBe(change!.sequence);
    await f.grant(`semantic:read:${first.component}`, 'semantic.read');
    const exact = await f.json<{ component: string; revision: string }>(await f.call('GET',
      `/v1/semantic/resources/${shortId(first.component)}/revisions/${shortId(first.revision)}`
      + `?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(exact).toMatchObject({ component: first.component, revision: first.revision });
  } finally {
    f.env.fuseki = original;
    await relay.end();
    await f.close();
  }
}, 180_000);
