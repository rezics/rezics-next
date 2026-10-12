import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient, FusekiHttpError, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { RelayEventBlocked, isRelayTransientFailure, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { runMainRelay } from '../src/modules/outbox/worker.ts';
import { RV } from '../src/modules/work/activate.ts';

const timeoutRelayEpoch = '11111111-1111-4111-8111-111111111111';
const timeoutRelayBatch = 'urn:rezics:outbox:timeout-retry';
const timeoutRelayEvent = 'urn:rezics:event:timeout-retry';

function bindings(values: Record<string, string>): SparqlResult {
  return { results: { bindings: [Object.fromEntries(Object.entries(values)
    .map(([name, value]) => [name, { type: 'literal', value }]))] } };
}

test('relay retries timeouts and connection loss with bounded backoff, then resumes delivery', async () => {
  let calls = 0, running = true;
  const delays: number[] = [], logs: string[] = [];
  await runMainRelay(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('owner unavailable'), {
      code: calls === 1 ? 'ETIMEDOUT' : 'ECONNRESET',
    });
    return false;
  }, () => running, 100, {
    sleep: async delay => { delays.push(delay); if (calls === 3) running = false; },
    random: () => 0,
    log: line => { logs.push(line); },
  });
  expect(calls).toBe(3);
  expect(delays).toEqual([250, 500, 100]);
  expect(logs.map(line => JSON.parse(line).event)).toEqual(['main_relay_retry', 'main_relay_retry']);
  expect(isRelayTransientFailure(Object.assign(new Error('owner unavailable'), { code: 'ECONNRESET' }))).toBe(true);
  expect(isRelayTransientFailure(Object.assign(new Error('owner unavailable'), { code: 'ETIMEDOUT' }))).toBe(true);
  expect(isRelayTransientFailure(new FusekiHttpError('Fuseki query returned 503', 503, 'Service Unavailable'))).toBe(true);
  expect(isRelayTransientFailure(new Error('Fuseki query returned 503'))).toBe(false);
  expect(isRelayTransientFailure(new Error('The operation timed out.'))).toBe(false);
  expect(isRelayTransientFailure(new Error('invalid event receipt'))).toBe(false);
});

test('relay retries a real envelope-read TimeoutError and continues delivery', async () => {
  let sequence = '0', retainedBatches = 0;
  const retainedEvents: string[] = [];
  let envelopeReads = 0;
  let resolveEnvelopeRequest!: () => void;
  const envelopeRequest = new Promise<void>(resolve => { resolveEnvelopeRequest = resolve; });
  const pool = { async query(sql: string, values?: unknown[]) {
    if (sql.startsWith('SELECT stream_scope, data_epoch, sequence FROM relay.checkpoint')) {
      return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
        data_epoch: timeoutRelayEpoch, sequence }], rowCount: 1 };
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
    const query = await request.text();
    if (query.includes('SELECT ?controlSequence')) {
      return Response.json(bindings({ controlSequence: '1', routing: 'routing',
        batch: timeoutRelayBatch, eventCount: '1', graphSequence: '1' }));
    }
    if (query.includes('SELECT ?event ?ordinal')) return Response.json(bindings({ event: timeoutRelayEvent, ordinal: '0' }));
    if (query.startsWith('ASK')) return Response.json({ boolean: true });
    if (query.includes('?kind ?ordinal ?action ?receipt')) {
      envelopeReads++;
      if (envelopeReads === 1) {
        resolveEnvelopeRequest();
        return new Promise<Response>(() => {});
      }
      return Response.json(bindings({ kind: `${RV}AdmissionCancelledEvent`, ordinal: '0',
        action: 'work.create', receipt: 'urn:rezics:receipt:timeout-retry', outcome: `${RV}Cancelled`,
        admissionId: '22222222-2222-4222-8222-222222222222', digest: 'a'.repeat(64),
        authorityEpoch: '1', scope: 'work:create', epoch: timeoutRelayEpoch, sequence: '1' }));
    }
    throw new Error(`unexpected Fuseki query: ${query}`);
  } });
  const baseUrl = `${server.url.href}rezics/`;
  class EnvelopeTimeoutFuseki extends FusekiClient {
    private timeoutNextEnvelope = true;
    override query(sparql: string, maxResponseBytes?: number,
      nativePhase?: 'occurrence-discovery'): Promise<SparqlResult> {
      if (this.timeoutNextEnvelope && sparql.includes('?kind ?ordinal ?action ?receipt')) {
        this.timeoutNextEnvelope = false;
        return new FusekiClient(baseUrl, undefined, undefined, AbortSignal.timeout(150))
          .query(sparql, maxResponseBytes, nativePhase);
      }
      return super.query(sparql, maxResponseBytes, nativePhase);
    }
  }
  const graph = new EnvelopeTimeoutFuseki(baseUrl);
  const errors: unknown[] = [], delays: number[] = [], logs: string[] = [];
  let running = true, delivered = false;
  try {
    await runMainRelay(async () => {
      try {
        const batch = await relayMainOutboxOnce(graph, pool, 'timeout-relay');
        delivered = batch?.sequence === '1';
        if (delivered) running = false;
        return batch !== null;
      } catch (error) { errors.push(error); throw error; }
    }, () => running, 100, { random: () => 0, log: line => { logs.push(line); },
      sleep: async delay => {
        delays.push(delay);
        expect(sequence).toBe('0');
        expect(retainedBatches).toBe(0);
        expect(retainedEvents).toEqual([]);
        await envelopeRequest;
      } });
    expect(delivered).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ name: 'TimeoutError' });
    expect(isRelayTransientFailure(errors[0])).toBe(true);
    expect(errors[0]).not.toBeInstanceOf(RelayEventBlocked);
    expect(envelopeReads).toBe(2);
    expect(delays).toEqual([250]);
    expect(logs.map(line => JSON.parse(line).event)).toEqual(['main_relay_retry']);
    expect(sequence).toBe('1');
    expect(retainedBatches).toBe(1);
    expect(retainedEvents).toHaveLength(1);
    expect(JSON.parse(retainedEvents[0]!).id).toBe(timeoutRelayEvent);
  } finally { await server.stop(true); }
});

test('relay stops only for a blocked event', async () => {
  const blocked = new RelayEventBlocked({ batchId: 'batch', dataEpoch: 'epoch', sequence: '1',
    routingEpoch: 'routing', eventIds: ['event'] }, 'event', 'invalid receipt');
  const delays: number[] = [];
  await expect(runMainRelay(async () => { throw blocked; }, () => true, 100, {
    sleep: async delay => { delays.push(delay); }, random: () => 0, log: () => {},
  })).rejects.toBe(blocked);
  expect(delays).toEqual([]);
});

test('relay retry delay stays capped during an extended outage', async () => {
  let attempts = 0, running = true;
  const delays: number[] = [];
  await runMainRelay(async () => { attempts++; throw new FusekiHttpError('Fuseki query returned 503', 503, 'Service Unavailable'); },
    () => running, 100, { random: () => 1, log: () => {}, sleep: async delay => {
      delays.push(delay);
      if (attempts === 10) running = false;
    } });
  expect(delays.at(-1)).toBe(30_000);
  expect(Math.max(...delays)).toBe(30_000);
});
