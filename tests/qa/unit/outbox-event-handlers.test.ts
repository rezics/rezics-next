import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { discoverOutboxEventHandlers } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { hash, RV } from '../../../services/main/src/modules/work/activate.ts';
import { OutboxIncomplete, RelayEventBlocked, readMainOutboxEnvelope, relayMainOutboxOnce,
  type MainOutboxBatch } from '../../../services/main/src/modules/outbox/relay.ts';

const kind = 'https://rezics.com/vocab/SyntheticChangedEvent';
const eventId = 'urn:rezics:event:synthetic';
const receiptId = 'urn:rezics:receipt:synthetic';
const batch: MainOutboxBatch = { streamScope: MAIN_RELAY_STREAM_SCOPE, graphSequence: '1', batchId: 'urn:rezics:outbox:synthetic', dataEpoch: 'epoch-1',
  sequence: '1', routingEpoch: 'route-1', eventIds: [eventId] };
const binding = (value: string) => ({ type: 'literal', value });

test('G-087: discovered owner event reads a validated receipt; mismatches hold the relay', async () => {
  await mkdir('.temp', { recursive: true });
  const root = await mkdtemp(join('.temp', 'outbox-handlers-'));
  try {
    await mkdir(join(root, 'synthetic'));
    await writeFile(join(root, 'synthetic', 'outbox-event.ts'), `
      export const outboxEventHandlers = [{
        kind: '${kind}', action: 'synthetic.change', type: 'com.rezics.synthetic.changed.v1',
        read: async ({ batch, eventId, value, ordinal }) => ({
          specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
          type: 'com.rezics.synthetic.changed.v1', datacontenttype: 'application/json',
          data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
            dataEpoch: batch.dataEpoch, sequence: batch.sequence }, routingEpoch: batch.routingEpoch,
            ordinal, receipt: { id: value('receipt'), action: value('action'),
              outcome: 'succeeded', admissionId: value('admissionId'),
              requestDigest: value('digest'), authorityEpoch: value('authorityEpoch'),
              scope: value('scope') } },
        }),
      }];\n`);
    const handlers = await discoverOutboxEventHandlers(root);
    const row = { kind: binding(kind), ordinal: binding('0'), action: binding('synthetic.change'),
      receipt: binding(receiptId), outcome: binding('https://rezics.com/vocab/Succeeded'),
      admissionId: binding('11111111-1111-4111-8111-111111111111'), digest: binding('a'.repeat(64)),
      authorityEpoch: binding('1'), scope: binding('synthetic:change:one'),
      epoch: binding(batch.dataEpoch), sequence: binding(batch.sequence) };
    const fuseki = { query: async () => ({ results: { bindings: [row] } }) } as unknown as FusekiClient;
    const select = (name: string) => handlers.get(name);
    const envelope = await readMainOutboxEnvelope(fuseki, batch, eventId, select);
    expect(envelope.type).toBe('com.rezics.synthetic.changed.v1');
    expect(envelope.data.receipt.action).toBe('synthetic.change');
    row.action = binding('synthetic.wrong');
    await expect(readMainOutboxEnvelope(fuseki, batch, eventId, select))
      .rejects.toBeInstanceOf(OutboxIncomplete);
    row.action = binding('synthetic.change');
    row.epoch = binding('wrong-epoch');
    await expect(readMainOutboxEnvelope(fuseki, batch, eventId, select))
      .rejects.toBeInstanceOf(OutboxIncomplete);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('G-266: a system Agent event without rv:action uses its exact owner proof', async () => {
  const admissionId = '11111111-1111-4111-8111-111111111111';
  const receipt = `urn:rezics:receipt:agent-provision:${admissionId}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const source = { ...batch, batchId: `urn:rezics:outbox:${hash(receipt)}`,
    eventIds: [event] };
  const agent = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
  const rows = [
    { kind: binding(`${RV}AgentCreatedEvent`), ordinal: binding('0'), receipt: binding(receipt),
      outcome: binding(`${RV}Succeeded`), digest: binding('a'.repeat(64)),
      epoch: binding(source.dataEpoch), sequence: binding(source.sequence) },
    { agent: binding(agent), operation: binding('urn:rezics:operation:agent-provision:one'),
      revision: binding('https://rezics.com/id/33333333-3333-4333-8333-333333333333'),
      manifest: binding(`urn:rezics:sha256:${'b'.repeat(64)}`) },
  ];
  let calls = 0;
  const fuseki = { query: async () => ({ results: { bindings: [rows[calls++]] } }) } as unknown as FusekiClient;
  const envelope = await readMainOutboxEnvelope(fuseki, source, event);
  expect(envelope.type).toBe('com.rezics.agent.created.v1');
  expect(envelope.data.receipt).toMatchObject({ action: 'agent.provision',
    systemProof: { kind: 'agent-created', agent } });
  calls = 0;
  rows[1] = {};
  await expect(readMainOutboxEnvelope(fuseki, source, event)).rejects.toThrow('graph proof');
});

test('G-266: Content rebuild phases share one validated event kind', async () => {
  const receipt = `urn:rezics:receipt:content-rebuild:clear:${'a'.repeat(64)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const source = { ...batch, batchId: `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`,
    eventIds: [event] };
  let calls = 0;
  const fuseki = { query: async () => ++calls === 1
    ? { results: { bindings: [{ kind: binding(`${RV}ContentRebuildEvent`),
      ordinal: binding('0'), action: binding('content.rebuild.clear'),
      receipt: binding(receipt), outcome: binding(`${RV}Succeeded`),
      digest: binding('b'.repeat(64)), epoch: binding(source.dataEpoch),
      sequence: binding(source.sequence) }] } }
    : { boolean: true } } as unknown as FusekiClient;
  const envelope = await readMainOutboxEnvelope(fuseki, source, event);
  expect(envelope.data.receipt).toMatchObject({ action: 'content.rebuild.clear',
    systemProof: { kind: 'content-rebuild', phase: 'clear' } });
  expect(calls).toBe(2);
});

test('G-266: an unknown kind stops its ordered position with event identity and reason', async () => {
  const eventId = 'urn:rezics:event:unknown-kind';
  const batchId = 'urn:rezics:outbox:unknown-kind';
  const rows = [
    { results: { bindings: [{ controlSequence: binding('1'), graphSequence: binding('1'), routing: binding('route-1'),
      batch: binding(batchId), eventCount: binding('1') }] } },
    { results: { bindings: [{ event: binding(eventId), ordinal: binding('0') }] } },
    { boolean: true },
    { results: { bindings: [{ kind: binding(`${RV}UnknownNewEvent`), ordinal: binding('0'),
      action: binding('unknown.change'), receipt: binding('urn:rezics:receipt:unknown'),
      outcome: binding(`${RV}Succeeded`),
      admissionId: binding('11111111-1111-4111-8111-111111111111'),
      digest: binding('a'.repeat(64)), authorityEpoch: binding('1'),
      scope: binding('unknown:change:one'), epoch: binding(batch.dataEpoch),
      sequence: binding('1') }] } },
  ];
  let index = 0;
  const fuseki = { query: async () => rows[index++] } as unknown as FusekiClient;
  const sql: string[] = [];
  const pool = { query: async (statement: string) => {
    sql.push(statement);
    return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: batch.dataEpoch, sequence: '0' }] };
  } } as unknown as Pool;
  const error = await relayMainOutboxOnce(fuseki, pool, 'test').catch(caught => caught);
  expect(error).toBeInstanceOf(RelayEventBlocked);
  expect(error).toMatchObject({ eventId, batch: { batchId, sequence: '1' },
    reason: `unsupported outbox event kind ${RV}UnknownNewEvent` });
  expect(sql).toHaveLength(1);
});

test('G-266: every statically emitted Main outbox kind has a relay reader', async () => {
  const emitted = new Set<string>();
  for (const file of new Bun.Glob('services/main/src/modules/**/*.ts').scanSync('.')) {
    if (file.endsWith('/outbox-event.ts') || file === 'services/main/src/modules/outbox/relay.ts') continue;
    const source = await readFile(file, 'utf8');
    if (!source.includes('GRAPHS.outbox') && !source.includes('OutboxBatch')) continue;
    // Include conditional kind names as well as literal RDF classes in an
    // outbox writer. Type names imported by the writer are not RDF classes.
    for (const match of source.matchAll(/\b([A-Z][A-Za-z0-9]*Event)\b/g)) {
      const kind = match[1]!;
      if (!kind.endsWith('CloudEvent') && !kind.endsWith('OutboxEvent')) emitted.add(kind);
    }
    if (source.includes('a rv:${def.operation}Event')) {
      for (const match of source.matchAll(/operation: '([A-Z][A-Za-z0-9]*)'/g)) {
        emitted.add(`${match[1]}Event`);
      }
    }
    if (source.includes('a rv:${kind}Event')) {
      for (const match of source.matchAll(/'([A-Z][A-Za-z0-9]*)'/g)) {
        if (match[1]?.startsWith('Zone')) emitted.add(`${match[1]}Event`);
      }
    }
  }
  const relay = await readFile('services/main/src/modules/outbox/relay.ts', 'utf8');
  const builtIn = new Set([...relay.matchAll(/\$\{RV\}([A-Za-z][A-Za-z0-9]*Event)/g)]
    .map(match => match[1]!));
  const owners = await discoverOutboxEventHandlers();
  const missing = [...emitted].filter(kind => !builtIn.has(kind)
    && !owners.has(`https://rezics.com/vocab/${kind}`)).sort();
  expect(emitted.size).toBeGreaterThan(75);
  expect(missing).toEqual([]);
});
