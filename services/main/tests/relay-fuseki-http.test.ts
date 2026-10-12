import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient, FusekiHttpError, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { RelayEventBlocked, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { runMainRelay } from '../src/modules/outbox/worker.ts';
import { RV } from '../src/modules/work/activate.ts';

const epoch = '11111111-1111-4111-8111-111111111111';
const batchId = 'urn:rezics:outbox:http-retry';
const eventId = 'urn:rezics:event:http-retry';
const receiptId = 'urn:rezics:receipt:http-retry';

function bindings(values: Record<string, string>): SparqlResult {
  return { results: { bindings: [Object.fromEntries(Object.entries(values)
    .map(([name, value]) => [name, { type: 'literal', value }]))] } };
}

/** Only SQL custody is stubbed; Fuseki HTTP and the relay event boundary stay real. */
function relayFixture(status: number) {
  let sequence = '0';
  let retainedBatches = 0;
  const retainedEvents: string[] = [];
  const envelopeStatuses: number[] = [];
  const pool = { async query(sql: string, values?: unknown[]) {
    if (sql.startsWith('SELECT stream_scope, data_epoch, sequence FROM relay.checkpoint')) {
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: epoch, sequence }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO relay.delivered_batch')) {
      retainedBatches++;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO relay.delivered_event')) {
      retainedEvents.push(String(values?.[4]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE relay.checkpoint')) {
      expect(values?.[3]).toBe(sequence);
      sequence = String(values?.[2]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected relay SQL: ${sql}`);
  } } as unknown as Pool;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe('/rezics/query');
    expect(request.method).toBe('POST');
    const query = await request.text();
    if (query.includes('SELECT ?controlSequence')) {
      return Response.json(bindings({ controlSequence: '1', routing: 'routing',
        batch: batchId, eventCount: '1', graphSequence: '1' }));
    }
    if (query.includes('SELECT ?event ?ordinal')) {
      return Response.json(bindings({ event: eventId, ordinal: '0' }));
    }
    if (query.startsWith('ASK')) return Response.json({ boolean: true });
    if (query.includes('?kind ?ordinal ?action ?receipt')) {
      const responseStatus = envelopeStatuses.length === 0 ? status : 200;
      envelopeStatuses.push(responseStatus);
      if (responseStatus !== 200) return new Response('owner unavailable', { status: responseStatus,
        statusText: responseStatus === 503 ? 'Service Unavailable'
          : responseStatus === 400 ? 'Bad Request' : 'Not Found' });
      // A terminal cancelled admission needs no revision or secondary owner reads.
      return Response.json(bindings({ kind: `${RV}AdmissionCancelledEvent`, ordinal: '0',
        action: 'work.create', receipt: receiptId, outcome: `${RV}Cancelled`,
        admissionId: '22222222-2222-4222-8222-222222222222', digest: 'a'.repeat(64),
        authorityEpoch: '1', scope: 'work:create', epoch, sequence: '1' }));
    }
    throw new Error(`unexpected Fuseki query: ${query}`);
  } });
  return { pool, graph: new FusekiClient(`http://127.0.0.1:${server.port}/rezics`), server,
    envelopeStatuses, retainedEvents, sequence: () => sequence, retainedBatches: () => retainedBatches };
}

test('relay retries a real Fuseki 503 event-envelope read and delivers after HTTP recovery', async () => {
  const fixture = relayFixture(503);
  const errors: unknown[] = [], delays: number[] = [], logs: string[] = [];
  let running = true;
  let delivered = false;
  try {
    await runMainRelay(async () => {
      try {
        const batch = await relayMainOutboxOnce(fixture.graph, fixture.pool, 'http-relay');
        delivered = batch?.sequence === '1';
        running = false;
        return batch !== null;
      } catch (error) { errors.push(error); throw error; }
    }, () => running, 100, { random: () => 0, log: line => { logs.push(line); },
      sleep: async delay => {
        delays.push(delay);
        expect(fixture.sequence()).toBe('0');
        expect(fixture.retainedBatches()).toBe(0);
        expect(fixture.retainedEvents).toEqual([]);
        // Bound a broken retry path so its assertion fails without hanging QA.
        if (delays.length > 1) running = false;
      } });
    expect(delivered).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(FusekiHttpError);
    expect(errors[0]).not.toBeInstanceOf(RelayEventBlocked);
    expect((errors[0] as FusekiHttpError).status).toBe(503);
    expect((errors[0] as FusekiHttpError).statusText).toBe('Service Unavailable');
    expect((errors[0] as Error).message).toBe('Fuseki query returned 503');
    expect(fixture.envelopeStatuses).toEqual([503, 200]);
    expect(delays).toEqual([250]);
    expect(logs.map(line => JSON.parse(line).event)).toEqual(['main_relay_retry']);
    expect(fixture.sequence()).toBe('1');
    expect(fixture.retainedBatches()).toBe(1);
    expect(fixture.retainedEvents).toHaveLength(1);
    const envelope = JSON.parse(fixture.retainedEvents[0]!);
    expect(envelope.id).toBe(eventId);
    expect(envelope.data.receipt.id).toBe(receiptId);
    expect(envelope.data.relayPosition).toEqual({ streamScope: MAIN_RELAY_STREAM_SCOPE,
      dataEpoch: epoch, sequence: '1' });
  } finally { await fixture.server.stop(true); }
});

for (const status of [400, 404]) {
  test(`relay blocks a real Fuseki ${status} event-envelope failure with its HTTP cause`, async () => {
    const fixture = relayFixture(status);
    const delays: number[] = [];
    let blocked: unknown;
    try {
      try {
        await runMainRelay(async () => (await relayMainOutboxOnce(fixture.graph,
          fixture.pool, 'http-relay')) !== null, () => true, 100, {
          sleep: async delay => { delays.push(delay); throw new Error('terminal failure must not retry'); },
          random: () => 0, log: () => {},
        });
      } catch (error) { blocked = error; }
      expect(blocked).toBeInstanceOf(RelayEventBlocked);
      const eventFailure = blocked as RelayEventBlocked;
      expect(eventFailure.eventId).toBe(eventId);
      expect(eventFailure.reason).toBe(`Fuseki query returned ${status}`);
      expect(eventFailure.cause).toBeInstanceOf(FusekiHttpError);
      expect((eventFailure.cause as FusekiHttpError).status).toBe(status);
      expect((eventFailure.cause as FusekiHttpError).statusText)
        .toBe(status === 400 ? 'Bad Request' : 'Not Found');
      expect((eventFailure.cause as Error).message).toBe(`Fuseki query returned ${status}`);
      expect(fixture.envelopeStatuses).toEqual([status]);
      expect(delays).toEqual([]);
      expect(fixture.sequence()).toBe('0');
      expect(fixture.retainedBatches()).toBe(0);
      expect(fixture.retainedEvents).toEqual([]);
    } finally { await fixture.server.stop(true); }
  });
}
