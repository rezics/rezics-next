import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { FusekiClient, SparqlResult } from '../src/infrastructure/fuseki.ts';
import { CLASSIFICATION_CONTEXT_PROFILE, CLASSIFICATION_CONTEXT_V2_PROFILE } from '../src/modules/classification/context.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { OutboxIncomplete, RelayEventBlocked, readMainOutboxEnvelope, relayMainOutboxOnce,
  type MainCloudEvent, type MainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { RV } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Values = Record<string, string | undefined>;
const bindings = (values: Values[]): SparqlResult => ({ results: { bindings: values.map(value =>
  Object.fromEntries(Object.entries(value).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, { type: 'literal', value }]]))) } });

function fixture() {
  const events = [1, 2, 3].map(n => {
    const revision = id(10 + n), operation = id(20 + n), graphSequence = String(n * 10);
    const expectedHead = n > 1 ? id(9 + n) : undefined;
    const profile = n === 1 ? CLASSIFICATION_CONTEXT_PROFILE : CLASSIFICATION_CONTEXT_V2_PROFILE;
    const eventId = `urn:rezics:event:classification-context-${n}`;
    return {
      batch: { streamScope: MAIN_RELAY_STREAM_SCOPE, batchId: `urn:rezics:outbox:classification-context-${n}`,
        dataEpoch: 'epoch', routingEpoch: 'routing', sequence: String(n), graphSequence, eventIds: [eventId] } satisfies MainOutboxBatch,
      receipt: {
        kind: `${RV}ClassificationContextCreatedEvent`, ordinal: '0', action: 'classification.context.configure',
        receipt: `urn:rezics:classification-context-receipt:${n}`, eventOperation: operation,
        eventRealm: id(1), outcome: `${RV}Succeeded`, admissionId: id(30 + n).slice(-36),
        digest: String(n).repeat(64), authorityEpoch: '0', scope: `classification:context:${id(1)}`,
        epoch: 'epoch', sequence: graphSequence, operation, realm: id(1),
        classificationContext: id(2), contextRevision: revision, expectedHead,
      } as Values,
      anchor: {
        manifest: `urn:rezics:sha256:${String(n + 3).repeat(64)}`, component: id(2), operation,
        profile, shape: profile, epoch: 'epoch', sequence: graphSequence, predecessor: expectedHead,
        priorComponent: n > 1 ? id(2) : undefined,
        priorProfile: n === 2 ? CLASSIFICATION_CONTEXT_PROFILE : n === 3 ? CLASSIFICATION_CONTEXT_V2_PROFILE : undefined,
        priorShape: n === 2 ? CLASSIFICATION_CONTEXT_PROFILE : n === 3 ? CLASSIFICATION_CONTEXT_V2_PROFILE : undefined,
        priorEpoch: n > 1 ? 'epoch' : undefined, priorSequence: n > 1 ? String((n - 1) * 10) : undefined,
        family: n > 1 ? 'classification-context-v2' : undefined,
        receiptAction: n > 1 ? 'classification.context.configure' : undefined,
      } as Values,
    };
  });
  const state = { checkpoint: '0', duplicateAnchor: false, missingAnchor: false, loseCheckpoint: false,
    reasonTerm: undefined as { type: string; datatype?: string; 'xml:lang'?: string } | undefined };
  const queries: string[] = [];
  const fuseki = { async query(query: string, maxResponseBytes?: number) {
    queries.push(query);
    if (query.includes('SELECT ?controlSequence')) {
      const sequence = query.match(/rv:streamSequence (\d+) \./)?.[1];
      const event = events.find(event => event.batch.sequence === sequence);
      return bindings([{ controlSequence: '3', routing: 'routing', ...(event ? {
        batch: event.batch.batchId, eventCount: '1', graphSequence: event.batch.graphSequence } : {}) }]);
    }
    const event = events.find(event => query.includes(`<${event.batch.batchId}>`)
      || query.includes(`<${event.batch.eventIds[0]}>`)
      || query.includes(`<${event.receipt.contextRevision}>`));
    if (!event) throw new Error(`unexpected Context relay query: ${query}`);
    if (query.includes('SELECT ?event ?ordinal')) return bindings([{ event: event.batch.eventIds[0], ordinal: '0' }]);
    if (query.startsWith('ASK')) return { boolean: true };
    if (query.includes('?kind ?ordinal ?action ?receipt')) {
      const result = bindings([event.receipt]);
      if (state.reasonTerm && result.results!.bindings[0]!.reason)
        Object.assign(result.results!.bindings[0]!.reason!, state.reasonTerm);
      return result;
    }
    if (query.includes('SELECT ?manifest ?component ?operation')) {
      expect(query).toContain('LIMIT 2');
      expect(maxResponseBytes).toBe(8192);
      expect(query).toContain(`<${event.receipt.receipt}> rv:commandFamily`);
      expect(query).toContain('rv:predecessor ?predecessor');
      return bindings(state.missingAnchor ? [] : state.duplicateAnchor ? [event.anchor, event.anchor] : [event.anchor]);
    }
    throw new Error(`unexpected Context relay query: ${query}`);
  } } as unknown as FusekiClient;
  const retained = new Map<string, MainCloudEvent>();
  const batches = new Map<string, unknown[]>();
  const deliveries: string[] = [];
  const pool = { async query(sql: string, values: unknown[] = []) {
    if (sql.startsWith('SELECT stream_scope, data_epoch, sequence FROM relay.checkpoint'))
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: state.checkpoint }], rowCount: 1 };
    if (sql.includes('INSERT INTO relay.delivered_batch')) {
      const key = String(values[1]);
      if (batches.has(key)) return { rows: [], rowCount: 0 };
      batches.set(key, values);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM relay.delivered_batch'))
      return { rows: [{ same: JSON.stringify(batches.get(String(values[1]))) === JSON.stringify(values) }], rowCount: 1 };
    if (sql.includes('INSERT INTO relay.delivered_event')) {
      const key = String(values[1]);
      if (retained.has(key)) return { rows: [], rowCount: 0 };
      retained.set(key, JSON.parse(String(values[4])) as MainCloudEvent);
      deliveries.push(key);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM relay.delivered_event')) {
      const event = retained.get(String(values[1]));
      return { rows: [{ same: JSON.stringify(event) === values[2]
        && event?.data.relayPosition?.dataEpoch === values[3]
        && event?.data.relayPosition?.sequence === values[4] }], rowCount: 1 };
    }
    if (sql.includes('UPDATE relay.checkpoint')) {
      if (state.loseCheckpoint) { state.loseCheckpoint = false; throw new Error('lost checkpoint update'); }
      expect(values[3]).toBe(state.checkpoint);
      state.checkpoint = String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected Context relay SQL: ${sql}`);
  } } as unknown as Pool;
  return { fuseki, pool, events, state, queries, retained, batches, deliveries };
}

function cancel(event: ReturnType<typeof fixture>['events'][number], reason?: string) {
  Object.assign(event.receipt, { kind: `${RV}ClassificationContextCancelledEvent`, outcome: `${RV}Cancelled`, reason,
    eventOperation: undefined, eventRealm: undefined, operation: undefined, realm: undefined,
    classificationContext: undefined, contextRevision: undefined, expectedHead: undefined });
}

test('relay accepts v1 creation, v2 creation, selection replacement and clear with exact manifests', async () => {
  const f = fixture();
  for (const event of f.events) {
    const envelope = await readMainOutboxEnvelope(f.fuseki, event.batch, event.batch.eventIds[0]!);
    expect(envelope.type).toBe('com.rezics.classification.context-created.v1');
    expect(envelope.data.receipt).toMatchObject({ classificationContext: id(2),
      contextRevision: event.receipt.contextRevision, contextManifest: event.anchor.manifest });
    expect(envelope.data.sourcePosition.sequence).toBe(event.batch.graphSequence);
    expect(envelope.data.relayPosition?.sequence).toBe(event.batch.sequence);
    if (event.receipt.expectedHead) expect(envelope.data.receipt).toHaveProperty('expectedHead', event.receipt.expectedHead);
    else expect(envelope.data.receipt).not.toHaveProperty('expectedHead');
  }
  const create = f.events[0]!;
  Object.assign(create.anchor, { profile: CLASSIFICATION_CONTEXT_V2_PROFILE, shape: CLASSIFICATION_CONTEXT_V2_PROFILE,
    family: 'classification-context-v2', receiptAction: 'classification.context.configure' });
  await expect(readMainOutboxEnvelope(f.fuseki, create.batch, create.batch.eventIds[0]!)).resolves.toMatchObject({
    data: { receipt: { contextManifest: create.anchor.manifest } } });
  // Restore starts a new graph epoch; the retained predecessor can have a
  // larger diagnostic sequence in the prior epoch.
  const replace = f.events[1]!;
  Object.assign(replace.anchor, { priorEpoch: 'prior-epoch', priorSequence: '2000' });
  await expect(readMainOutboxEnvelope(f.fuseki, replace.batch, replace.batch.eventIds[0]!)).resolves.toMatchObject({
    data: { receipt: { expectedHead: replace.receipt.expectedHead } } });
  expect(f.queries.every(query => !query.includes('urn:rezics:graph:current'))).toBe(true);
});

test('relay refuses missing, ambiguous and mismatched retained Context revision proofs', async () => {
  for (const override of [
    { manifest: 'urn:bad' }, { component: id(99) }, { operation: id(99) }, { epoch: 'wrong' }, { sequence: '2' },
    { profile: 'urn:unknown' }, { shape: CLASSIFICATION_CONTEXT_PROFILE }, { predecessor: undefined },
    { predecessor: id(99) }, { predecessor: id(12) }, { priorComponent: id(99) }, { priorComponent: undefined },
    { priorProfile: 'urn:unknown' }, { priorShape: CLASSIFICATION_CONTEXT_V2_PROFILE },
    { priorEpoch: undefined }, { priorSequence: '0' }, { priorSequence: '20' }, { priorSequence: '30' }, { priorSequence: 'bad' },
    { family: undefined }, { family: 'work-edit-v1' }, { receiptAction: 'work.edit' },
  ]) {
    const f = fixture(), event = f.events[1]!;
    Object.assign(event.anchor, override);
    await expect(readMainOutboxEnvelope(f.fuseki, event.batch, event.batch.eventIds[0]!))
      .rejects.toBeInstanceOf(OutboxIncomplete);
  }
  const f = fixture(), event = f.events[1]!;
  f.state.duplicateAnchor = true;
  await expect(readMainOutboxEnvelope(f.fuseki, event.batch, event.batch.eventIds[0]!))
    .rejects.toBeInstanceOf(OutboxIncomplete);
  f.state.duplicateAnchor = false;
  f.state.missingAnchor = true;
  await expect(readMainOutboxEnvelope(f.fuseki, event.batch, event.batch.eventIds[0]!))
    .rejects.toBeInstanceOf(OutboxIncomplete);
});

test('relay refuses replacement heads on v1 and mismatched Context receipt/event identities', async () => {
  for (const override of [
    { expectedHead: undefined }, { expectedHead: id(99) }, { classificationContext: id(99) },
    { contextRevision: undefined }, { realm: id(99) }, { eventRealm: id(99) }, { eventOperation: id(99) },
    { outcome: `${RV}Cancelled` }, { action: 'work.edit' }, { scope: `classification:context:${id(99)}` },
    { work: id(99) }, { reason: 'stale-head' },
  ]) {
    const f = fixture(), event = f.events[1]!;
    Object.assign(event.receipt, override);
    await expect(readMainOutboxEnvelope(f.fuseki, event.batch, event.batch.eventIds[0]!))
      .rejects.toBeInstanceOf(OutboxIncomplete);
  }
  const f = fixture(), event = f.events[0]!;
  event.receipt.expectedHead = id(99);
  event.anchor.predecessor = id(99);
  await expect(readMainOutboxEnvelope(f.fuseki, event.batch, event.batch.eventIds[0]!))
    .rejects.toBeInstanceOf(OutboxIncomplete);
});

test('Context replacements relay in delivery order, replay after lost acknowledgement, and block before invalid receipts', async () => {
  const f = fixture();
  await relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay');
  f.state.loseCheckpoint = true;
  await expect(relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay')).rejects.toThrow('lost checkpoint update');
  expect(f.state.checkpoint).toBe('1');
  expect(f.retained.size).toBe(2);
  await relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay');
  expect(f.state.checkpoint).toBe('2');
  expect(f.retained.size).toBe(2);
  const clear = f.events[2]!;
  clear.anchor.predecessor = id(99);
  await expect(relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay')).rejects.toBeInstanceOf(RelayEventBlocked);
  expect(f.state.checkpoint).toBe('2');
  expect(f.batches.size).toBe(2);
  expect(f.retained.size).toBe(2);
  clear.anchor.predecessor = clear.receipt.expectedHead;
  await relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay');
  expect(await relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay')).toBeNull();
  expect(f.deliveries).toEqual(f.events.map(event => event.batch.eventIds[0]!));
  expect([...f.retained.values()].map(event => [event.data.relayPosition?.sequence, event.data.sourcePosition.sequence]))
    .toEqual([['1', '10'], ['2', '20'], ['3', '30']]);
  f.state.checkpoint = '1';
  f.events[1]!.anchor.manifest = `urn:rezics:sha256:${'a'.repeat(64)}`;
  await expect(relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay')).rejects.toBeInstanceOf(OutboxIncomplete);
  expect(f.state.checkpoint).toBe('1');
  expect(f.retained.size).toBe(3);
});

test('both Context cancellation reasons survive ordered relay and replay beside a v1 success', async () => {
  const f = fixture();
  cancel(f.events[1]!, 'stale-head');
  cancel(f.events[2]!, 'scheme-unavailable');
  await relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay');
  f.state.loseCheckpoint = true;
  await expect(relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay')).rejects.toThrow('lost checkpoint update');
  expect(f.state.checkpoint).toBe('1');
  await relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay');
  await relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay');
  expect(f.deliveries).toEqual(f.events.map(event => event.batch.eventIds[0]!));
  expect([...f.retained.values()].map(event => [event.data.receipt.reason,
    event.data.sourcePosition.sequence, event.data.relayPosition?.sequence]))
    .toEqual([[undefined, '10', '1'], ['stale-head', '20', '2'], ['scheme-unavailable', '30', '3']]);
  f.state.checkpoint = '2';
  await relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay');
  expect(f.retained.size).toBe(3);
  expect(f.state.checkpoint).toBe('3');
  const legacy = fixture(), event = legacy.events[0]!;
  cancel(event);
  const delivered = await readMainOutboxEnvelope(legacy.fuseki, event.batch, event.batch.eventIds[0]!);
  expect(delivered.data.receipt).not.toHaveProperty('reason');
});

test('Context cancellation relay refuses unknown, malformed or mixed successful receipts without advancing', async () => {
  for (const reason of ['', 'unknown', `${RV}StaleHead`, 'Stale-head', 'scheme-unavailable\n']) {
    const f = fixture(); cancel(f.events[0]!, reason);
    await expect(relayMainOutboxOnce(f.fuseki, f.pool, 'context-relay')).rejects.toBeInstanceOf(RelayEventBlocked);
    expect(f.retained.size).toBe(0); expect(f.batches.size).toBe(0); expect(f.state.checkpoint).toBe('0');
  }
  for (const term of [{ type: 'uri' }, { type: 'literal', 'xml:lang': 'en' },
    { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }]) {
    const f = fixture(), event = f.events[0]!; cancel(event, 'stale-head'); f.state.reasonTerm = term;
    await expect(readMainOutboxEnvelope(f.fuseki, event.batch, event.batch.eventIds[0]!)).rejects.toBeInstanceOf(OutboxIncomplete);
  }
  for (const override of [{ operation: id(99) }, { expectedHead: id(99) }, { classificationContext: id(99) },
    { realm: id(99) }, { outcome: `${RV}Succeeded` }, { action: 'work.edit' }, { scope: 'work:create' }]) {
    const f = fixture(), event = f.events[0]!; cancel(event, 'scheme-unavailable'); Object.assign(event.receipt, override);
    await expect(readMainOutboxEnvelope(f.fuseki, event.batch, event.batch.eventIds[0]!)).rejects.toBeInstanceOf(OutboxIncomplete);
  }
});
