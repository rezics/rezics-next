import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StatementSeek } from '../src/modules/statement/seek.ts';
import { acceptedStatementPattern } from '../src/modules/statement/subject-read.ts';
import { reconcileRetainedEmptyBatch } from '../src/modules/work/reconcile-restored.ts';
import { relayCoverage } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { discoveryChanges } from '../src/modules/discovery/changes.ts';
import { assertFrozenContentRebuildAuthority } from '../src/modules/content-publication/rebuild-authority.ts';

const root = resolve(import.meta.dir, '../../..');

async function projectionQueries(through: number) {
  const queries: string[] = [];
  const client = { query: async (sql: string) => ({ rows: sql.includes('FROM access.statement_seek_coverage')
    ? [{ complete: true, through_sequence: String(through) }] : [] }), release() {} };
  const pool = { query: client.query, connect: async () => client } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch' }, fuseki: { query: async (query: string) => {
    queries.push(query);
    if (query.includes('OutboxBatch')) {
      const sequences = query.match(/VALUES \?sequence \{\s*([^}]+)\}/)![1]!.trim().split(/\s+/);
      return { results: { bindings: sequences.map(value => ({ sequence: { value },
        batch: { value: `urn:rezics:test:batch:${value}` }, count: { value: '0' } })) } };
    }
    if (query.includes('SELECT ?sequence WHERE'))
      return { results: { bindings: [{ sequence: { value: '64' } }] } };
    return { results: { bindings: [] } };
  } } } as unknown as WorkActivationEnvironment;
  expect(await new StatementSeek(pool, env).projectOnce()).toBe(true);
  return queries.filter(query => query.includes('VALUES ?sequence'));
}

async function restoredBatchQuery() {
  const queries: string[] = [];
  const batches = Array.from({ length: 64 }, (_, i) => ({ sequence: String(i + 1),
    batch_id: `urn:rezics:test:batch:${i + 1}`, routing_epoch: 'routing', event_count: 0, actual_count: '0' }));
  const relayClient = { query: async (sql: string) => {
    if (sql.includes('FROM relay.checkpoint')) return { rows: [{ stream_scope: MAIN_RELAY_STREAM_SCOPE,
      data_epoch: 'epoch', sequence: '64' }], rowCount: 1 };
    if (sql.includes('FROM relay.delivered_batch AS batch')) return { rows: batches, rowCount: 64 };
    if (sql.includes('SELECT batch_id, routing_epoch, event_count')) return { rows: [batches[63]], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }, release() {} };
  const relayPool = { query: relayClient.query, connect: async () => relayClient } as unknown as Pool;
  const coverage = await relayCoverage(relayPool, 'test');
  expect(coverage.eventDigest).toBe(createHash('sha256').digest('hex'));
  const accessClient = { query: async (sql: string) => ({ rows: sql.includes('SELECT open')
    ? [{ open: false }] : [] }), release() {} };
  const env = { lineage: { dataEpoch: 'restored', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string) => {
      queries.push(query);
      if (query.includes('SELECT ?saved')) return { results: { bindings: [{ saved: { value: '64' } }] } };
      if (query.includes('SELECT ?cursor')) return { results: { bindings: [{ cursor: { value: '64' } }] } };
      if (query.includes('OutboxBatch')) return { results: { bindings: [{
        batch: { value: batches[63]!.batch_id }, count: { value: '0' },
      }] } };
      throw new Error('Unexpected restore query');
    },
  } } as unknown as WorkActivationEnvironment;
  expect(await reconcileRetainedEmptyBatch(env, { connect: async () => accessClient } as unknown as Pool,
    relayPool, coverage, '64')).toEqual({ batchId: batches[63]!.batch_id, replayed: true });
  return queries.find(query => query.includes('OutboxBatch'))!;
}

function sequenceFirst(query: string, subject: string, type: string, sequence: string) {
  const lookup = query.indexOf(`${subject} rv:sequence ${sequence}`);
  const constraint = query.indexOf(`${subject} a rv:${type}`);
  expect(lookup).toBeGreaterThanOrEqual(0);
  expect(constraint).toBeGreaterThan(lookup);
}

const requestedSequences = (query: string) => query.match(/VALUES \?sequence \{\s*([^}]+)\}/)?.[1]
  ?.trim().split(/\s+/).map(Number) ?? [Number(query.match(/\?batch rv:sequence (\d+)/)![1])];

async function discoveryQuery(through: number) {
  let captured = '';
  const session = { position: { dataEpoch: 'epoch', sequence: '64' }, query: async (query: string) => {
    captured = query;
    return requestedSequences(query).map(sequence => ({ sequence: { value: String(sequence) },
      batch: { value: `urn:rezics:test:batch:${sequence}` }, count: { value: '1' },
      event: { value: `urn:rezics:test:event:${sequence}` }, ordinal: { value: '0' },
      action: { value: 'work.edit' }, work: { value: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001' } }));
  } } as unknown as WorkReadSession;
  expect(await discoveryChanges(session, String(through))).not.toBeNull();
  return captured;
}

async function rebuildAuthorityQueries(through: number, end = 64) {
  const queries: string[] = [];
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string) => {
      if (query.includes('SELECT ?sequence ?mainSequence')) return { results: { bindings: [{
        sequence: { value: String(end) }, mainSequence: { value: '1' },
      }] } };
      queries.push(query);
      return { results: { bindings: requestedSequences(query).map(sequence => ({
        sequence: { value: String(sequence) }, batch: { value: `urn:rezics:test:batch:${sequence}` },
        allowed: { value: 'true' },
      })) } };
    },
  } } as unknown as WorkActivationEnvironment;
  await assertFrozenContentRebuildAuthority(env, { dataEpoch: 'epoch', routingEpoch: 'routing',
    graphSequence: String(through), mainSequence: '1' }, { owner: 'content', dataEpoch: 'content', sequence: '1' });
  return queries;
}

test('audited bounded lookups bind sequence or identity before checking type', async () => {
  for (const through of [63, 62]) {
    const queries = await projectionQueries(through);
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query).toContain(`VALUES ?sequence { ${through === 63 ? '64' : '63 64'} }`);
      expect(query).toContain('rv:dataEpoch "epoch"');
    }
    sequenceFirst(queries[0]!, '?batch', 'OutboxBatch', '?sequence');
    sequenceFirst(queries[1]!, '?revision', 'StatementRevision', '?sequence');
    sequenceFirst(queries[2]!, '?revision', 'SemanticRevision', '?sequence');
    const discovery = await discoveryQuery(through);
    sequenceFirst(discovery, '?batch', 'OutboxBatch', '?sequence');
    expect(discovery).toContain(`VALUES ?sequence { ${through === 63 ? '64' : '63 64'} }`);
    const [authority] = await rebuildAuthorityQueries(through);
    sequenceFirst(authority!, '?batch', 'OutboxBatch', '?sequence');
    expect(authority).toContain(`VALUES ?sequence { ${through === 63 ? '64' : '63 64'} }`);
    expect(authority).toContain('?operation rv:sequence ?sequence . ?operation a rv:OperationReceipt');
  }
  sequenceFirst(await restoredBatchQuery(), '?batch', 'OutboxBatch', '64');
  const acceptance = acceptedStatementPattern('https://rezics.com/id/00000000-0000-4000-8000-000000000001', true);
  expect(acceptance).toMatch(/\?blockingSlot rv:decisionTarget \?decisionTarget\s*;[\s\S]*?a rv:DecisionSlot/);
  // These private query templates are also guarded at their authored identity
  // joins; the projection queries above are captured from real owner calls.
  const subject = readFileSync(join(root, 'services/main/src/modules/statement/subject-read.ts'), 'utf8');
  expect(subject).toMatch(/\?statement rdf:subject \$\{iri\(resource\)\}[^}]*?a rdf:Statement/);
  const conversion = readFileSync(join(root, 'services/main/src/modules/statement/populated-conversion.ts'), 'utf8');
  expect(conversion).toContain('?revision rv:component ?statement ; a rv:StatementRevision');
  expect(conversion).toMatch(/\?decision rv:convertedFrom \$\{iri\(head\)\}\s*;[^\n]*?a rv:StatementDecision/);
});

interface Batch { id: string; sequence: number; epoch: string; type: string }

/** Model indexed first-pattern evaluation, counting emitted batch candidates.
 * This guards the client query shape; the separate native proof measures ARQ. */
function countingFuseki(population: number) {
  const batches: Batch[] = Array.from({ length: population }, (_, i) => ({
    id: `urn:rezics:test:batch:${i + 1}`, sequence: i + 1, epoch: 'epoch', type: 'OutboxBatch',
  }));
  for (const sequence of [63, 64]) {
    batches.push({ id: `urn:other-epoch:${sequence}`, sequence, epoch: 'other', type: 'OutboxBatch' });
    batches.push({ id: `urn:wrong-type:${sequence}`, sequence, epoch: 'epoch', type: 'Other' });
  }
  const bySequence = new Map<number, Batch[]>();
  const byType = new Map<string, Batch[]>();
  for (const batch of batches) {
    bySequence.set(batch.sequence, [...bySequence.get(batch.sequence) ?? [], batch]);
    byType.set(batch.type, [...byType.get(batch.type) ?? [], batch]);
  }
  return { query(query: string) {
    const sequences = requestedSequences(query);
    const epoch = query.match(/rv:dataEpoch "([^"]+)"/)![1];
    const first = query.match(/\?batch\s+(a rv:OutboxBatch|rv:sequence (?:\?sequence|\d+))/)![1];
    const rows: Batch[] = [];
    let visited = 0;
    for (const sequence of sequences) {
      const candidates = first === 'a rv:OutboxBatch' ? byType.get('OutboxBatch')! : bySequence.get(sequence) ?? [];
      for (const batch of candidates) {
        visited++;
        if (batch.sequence === sequence && batch.epoch === epoch && batch.type === 'OutboxBatch') rows.push(batch);
      }
    }
    return { rows: rows.map(batch => batch.id), visited };
  } };
}

test('Main counting client keeps sequence lookup work constant at N and 16N', async () => {
  const small = countingFuseki(64), large = countingFuseki(1024);
  for (const through of [63, 62]) {
    const [statement] = await projectionQueries(through);
    const [authority] = await rebuildAuthorityQueries(through);
    for (const query of [statement!, authority!, await discoveryQuery(through), await restoredBatchQuery()]) {
      const before = small.query(query), after = large.query(query);
      expect(before.rows).toEqual(requestedSequences(query).map(sequence => `urn:rezics:test:batch:${sequence}`));
      expect(after).toEqual(before);
      expect(before.visited).toBe(requestedSequences(query).length * 3);
    }
    const old = statement!.replace('?batch rv:sequence ?sequence . ?batch a rv:OutboxBatch ; rv:dataEpoch "epoch"',
      '?batch a rv:OutboxBatch ; rv:dataEpoch "epoch" ; rv:sequence ?sequence');
    expect(old).not.toBe(statement);
    const before = small.query(old), after = large.query(old);
    expect(after.rows).toEqual(before.rows);
    expect(after.visited).toBeGreaterThan(before.visited * 8);
  }
});

test('frozen rebuild authority binds at most 64 contiguous sequence values per page', async () => {
  const queries = await rebuildAuthorityQueries(0, 130);
  expect(queries).toHaveLength(3);
  const pages = queries.map(requestedSequences);
  expect(pages.map(page => page.length)).toEqual([64, 64, 2]);
  expect(pages.flat()).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
  for (const query of queries) {
    expect(query.indexOf('VALUES ?sequence')).toBeGreaterThan(query.indexOf('{ SELECT ?batch ?sequence ?count WHERE'));
    expect(query).toContain('ORDER BY ?sequence STR(?batch) LIMIT 64');
  }
});
