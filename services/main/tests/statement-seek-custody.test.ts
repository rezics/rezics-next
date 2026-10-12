import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { StatementSeek, STATEMENT_SEEK_COST } from '../src/modules/statement/seek.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { CustodiedOutbox } from '../src/modules/outbox/relay.ts';

const batchId = 'urn:rezics:test:batch:64';
const receipt = 'urn:rezics:test:receipt:64';
const statement = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const retained = (): CustodiedOutbox => ({ batch: { batchId, dataEpoch: 'epoch', sequence: '7',
  graphSequence: '64', routingEpoch: 'routing', eventIds: [], custodiedReceipt: receipt }, events: [] });
const record = (graph = '64', stream = '7') => ({ graph_sequence: graph, stream_sequence: stream,
  receipt, batch_id: `urn:rezics:test:batch:${graph}` });

function projection(input: { headers?: { sequence: string; batch: string; count?: string; stream?: string }[];
  proofs?: { sequence: string; receipt: string; stream: string }[];
  records?: ReturnType<typeof record>[]; custody?: CustodiedOutbox | null; through?: number; position?: number;
  unavailable?: boolean; changed?: boolean } = {}) {
  const sql: { text: string; values?: unknown[] }[] = [];
  const lookups: string[][] = [];
  const queries: string[] = [];
  const client = { query: async (text: string, values?: unknown[]) => {
    sql.push({ text, values });
    if (text.includes('FROM access.statement_seek_coverage'))
      return { rows: [{ complete: true, through_sequence: String(input.through ?? 63) }] };
    if (text.includes('FROM access.command_custody')) return { rows: input.records ?? [record()] };
    return { rows: [] };
  }, release() {} };
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, receiptCustody: {
    read: async (epoch: string, stream: string) => {
      lookups.push([epoch, stream]);
      if (input.unavailable) throw new Error('Owner unavailable');
      if (input.position && input.position > 64) {
        const graph = input.records?.find(row => row.stream_sequence === stream)?.graph_sequence;
        return { ...retained(), batch: { ...retained().batch, sequence: stream, graphSequence: graph,
          batchId: `urn:rezics:test:batch:${graph}` } };
      }
      return input.custody === undefined ? retained() : input.custody;
    },
  }, fuseki: { query: async (query: string) => {
    queries.push(query);
    const binding = (value: string) => ({ value });
    if (query.includes('OutboxBatch')) {
      const sequences = query.match(/VALUES \?sequence \{\s*([^}]+)\}/)![1]!.trim().split(/\s+/);
      const headers = input.headers ?? [];
      const rows = headers.map(header => ({ sequence: binding(header.sequence), batch: binding(header.batch),
        count: binding(header.count ?? '0'), ...(header.stream ? { streamSequence: binding(header.stream) } : {}) }));
      return { results: { bindings: sequences.flatMap(sequence => {
        const own = rows.filter(row => row.sequence.value === sequence);
        const proofs = input.proofs?.filter(proof => proof.sequence === sequence) ?? [];
        return (own.length ? own : [{ sequence: binding(sequence) }]).flatMap(row => proofs.length
          ? proofs.map(proof => ({ ...row, receipt: binding(proof.receipt), proofStream: binding(proof.stream) })) : [row]);
      }).concat(rows.filter(row => !sequences.includes(row.sequence.value))) } };
    }
    if (query.includes('SELECT ?sequence WHERE'))
      return { results: { bindings: [{ sequence: binding(String(input.position ?? 64)) }] } };
    if (input.changed && query.includes('SELECT DISTINCT ?statement'))
      return { results: { bindings: [{ statement: binding(statement) }] } };
    if (input.changed && query.includes('SELECT ?statement ?subject'))
      return { results: { bindings: [{ statement: binding(statement), subject: binding('urn:subject'),
        predicate: binding('urn:predicate'), key: binding('urn:meaning'), head: binding('urn:head') }] } };
    return { results: { bindings: [] } };
  } } } as unknown as WorkActivationEnvironment;
  const pool = { query: client.query, connect: async () => client } as unknown as Pool;
  return { seek: new StatementSeek(pool, env), sql, lookups, queries };
}

test('slim graph sequence projects through its distinct custodied Main stream position', async () => {
  const run = projection({ changed: true });
  expect(await run.seek.projectOnce()).toBe(true);
  expect(run.lookups).toEqual([['epoch', '7']]);
  expect(run.sql.some(query => query.text.includes('INSERT INTO access.statement_seek\n'))).toBe(true);
  expect(run.sql.find(query => query.text.includes('SET through_sequence=GREATEST'))?.values).toEqual(['epoch', '64']);
});

test('holes, ambiguous custody and disagreeing physical headers never advance coverage', async () => {
  const wrongGraph = retained(); wrongGraph.batch.graphSequence = '7';
  const wrongEpoch = retained(); wrongEpoch.batch.dataEpoch = 'other';
  const wrongStream = retained(); wrongStream.batch.sequence = '64';
  const wrongReceipt = retained(); wrongReceipt.batch.custodiedReceipt = 'urn:other';
  const wrongRouting = retained(); wrongRouting.batch.routingEpoch = 'other';
  const wrongBatch = retained(); wrongBatch.batch.batchId = 'urn:other';
  for (const input of [
    { records: [] }, { custody: null }, { records: [record(), record('64', '8')] },
    { custody: wrongGraph }, { custody: wrongEpoch }, { custody: wrongStream }, { custody: wrongReceipt },
    { custody: wrongRouting }, { custody: wrongBatch },
    { unavailable: true }, { headers: [{ sequence: '64', batch: 'urn:other' }] },
    { headers: [{ sequence: '64', batch: batchId, count: '1' }] },
    { headers: [{ sequence: '64', batch: batchId, stream: '64' }] },
    { headers: [{ sequence: '64', batch: batchId }, { sequence: '64', batch: batchId }] },
    { headers: [{ sequence: '65', batch: batchId }] },
  ]) {
    const run = projection(input);
    await expect(run.seek.projectOnce()).rejects.toThrow('Statement index outbox coverage is incomplete');
    expect(run.sql.some(query => query.text.includes('SET through_sequence=GREATEST'))).toBe(false);
    expect(run.sql.at(-1)?.text).toBe('ROLLBACK');
    expect(run.lookups.length).toBeLessThanOrEqual(1);
  }
});

test('physical headers cover ordinary batches and agree with retained custody', async () => {
  for (const records of [[], [record()]]) {
    const run = projection({ records, headers: [{ sequence: '64', batch: batchId, stream: '7' }] });
    expect(await run.seek.projectOnce()).toBe(true);
    expect(run.lookups).toHaveLength(records.length);
  }
});

test('compact proof recovers interrupted reconciliation through the custody owner', async () => {
  const run = projection({ records: [], proofs: [{ sequence: '64', receipt, stream: '7' }] });
  expect(await run.seek.projectOnce()).toBe(true);
  expect(run.lookups).toEqual([['epoch', '7']]);
});

test('proof and durable custody must bind the same exact receipt and Main position', async () => {
  for (const proofs of [
    [{ sequence: '64', receipt, stream: '64' }],
    [{ sequence: '64', receipt: 'urn:other', stream: '7' }],
    [{ sequence: '64', receipt, stream: '7' }, { sequence: '64', receipt, stream: '8' }],
  ]) {
    const run = projection({ proofs });
    await expect(run.seek.projectOnce()).rejects.toThrow('Statement index outbox coverage is incomplete');
    expect(run.lookups).toHaveLength(0);
  }
});

test('one projection turn maps custody once and reads each missing batch at most once', async () => {
  const records = Array.from({ length: STATEMENT_SEEK_COST.projectionSequences }, (_, i) => record(String(i + 1), String(i + 101)));
  const run = projection({ through: 0, position: 130, records });
  expect(await run.seek.projectOnce()).toBe(true);
  expect(run.sql.filter(query => query.text.includes('FROM access.command_custody'))).toHaveLength(1);
  expect(run.lookups).toEqual(records.map(row => ['epoch', row.stream_sequence]));
  expect(run.sql.find(query => query.text.includes('SET through_sequence=GREATEST'))?.values).toEqual(['epoch', '64']);
});
