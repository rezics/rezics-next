import { expect, spyOn, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { boundedPool, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { controlTransaction } from '../src/modules/access/topology-control.ts';
import { PostgresReceiptCustodyStore } from '../src/modules/outbox/receipt-custody.ts';
import { StatementSeek } from '../src/modules/statement/seek.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const subject = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const epoch = 'epoch-publication';
const storage = 'native-store';
const seal = 'ab'.repeat(32);

function scriptedClient(answer: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount?: number }): PoolClient {
  const client = {
    query(sql: string, values?: unknown, cb?: (err: unknown, result?: unknown) => void) {
      const params = typeof values === 'function' ? [] : values ?? [];
      const callback = typeof values === 'function' ? values as (err: unknown, result?: unknown) => void : cb;
      const result = answer(sql, params as unknown[]);
      if (callback) { callback(undefined, result); return undefined; }
      return Promise.resolve(result);
    },
    release() {},
    on() { return client; },
    once() { return client; },
    removeListener() { return client; },
  };
  return client as unknown as PoolClient;
}

function installConnect(answer: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  return spyOn(Pool.prototype, 'connect').mockImplementation(((callback?: (err: Error | undefined, client: PoolClient, done: () => void) => void) => {
    const client = scriptedClient(answer);
    if (typeof callback === 'function') {
      callback(undefined, client, () => { client.release(); });
      return undefined as unknown as Promise<PoolClient>;
    }
    return Promise.resolve(client);
  }) as Pool['connect']);
}

test('publication build rechecks its basis on the transaction it already holds', async () => {
  const previous = nestedPoolCheckoutMode();
  const row = { membership_head: null as string | null, recovery_basis: '1', complete: false,
    build_id: '00000000-0000-4000-8000-0000000000bb', step_revision: '1', phase: 'building' as const,
    native_storage: storage, physical_cursor: null as unknown };
  const connect = installConnect((sql, values) => {
    if (sql.includes('pg_advisory') || sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('recovery_fence')) return { rows: [{ generation: '1', open: true }] };
    if (sql.startsWith('SELECT subject')) return { rows: [{ subject }] };
    if (sql.startsWith('UPDATE access.statement_publication_seek_coverage')) {
      row.phase = values[4] as 'building';
      row.physical_cursor = values[5] == null ? null : JSON.parse(String(values[5]));
      row.complete = Boolean(values[6]);
      row.step_revision = String(BigInt(row.step_revision) + 1n);
      return { rows: [{ ...row }] };
    }
    if (sql.includes('statement_publication_seek_coverage')) return { rows: [{ ...row }] };
    throw new Error(`unexpected publication sql: ${sql}`);
  });
  const pool = boundedPool({ host: '127.0.0.1', port: 1, database: 'access', max: 4, connectionTimeoutMillis: 50 });
  const basis = { dataEpoch: epoch, routingEpoch: 'routing', subject, membershipHead: null, storage };
  const eof = { storage, phase: 2 as const, key: '', seal };
  const env = { lineage: { dataEpoch: epoch, routingEpoch: 'routing' }, fuseki: {
    async query() {
      return { results: { bindings: [{ globalFacts: { type: 'literal', value: 'false' } }] } };
    },
    async templateIndex(input: { after?: unknown }) {
      if (input.after === 'basis') return { basis, after: null, complete: false, examined: 0, witnessTuples: 0, references: [] };
      return { basis, after: eof, complete: true, examined: 0, witnessTuples: 0, references: [] };
    },
  } } as unknown as WorkActivationEnvironment;
  setNestedPoolCheckoutMode('throw');
  try {
    const progressed = await new StatementSeek(pool, env).projectPublicationOnce();
    expect(progressed).toBe(true);
    expect(row.complete).toBe(true);
  } finally {
    setNestedPoolCheckoutMode(previous);
    connect.mockRestore();
    await pool.end();
  }
});

test('receipt custody keeps its lock while topology control uses the caller pool', async () => {
  const previous = nestedPoolCheckoutMode();
  const connect = installConnect(sql => ({
    rows: sql.includes('recovery_fence') ? [{ open: true }] : [], rowCount: 1,
  }));
  const pool = boundedPool({ host: '127.0.0.1', port: 1, database: 'access', max: 4, connectionTimeoutMillis: 50 });
  const store = new PostgresReceiptCustodyStore(pool);
  setNestedPoolCheckoutMode('throw');
  try {
    const held = await pool.connect();
    try {
      const borrowed = await store.withReceipt('urn:rezics:receipt:borrowed', async session => {
        expect(session.client).toBe(held);
        return 'borrowed';
      }, held);
      expect(borrowed).toBe('borrowed');
    } finally { held.release(); }
    const guarded = await store.withReceipt('urn:rezics:receipt:guarded', async () => {
      await controlTransaction(pool, async client => { await client.query('SELECT 1'); });
      return 'guarded';
    });
    expect(guarded).toBe('guarded');
  } finally {
    setNestedPoolCheckoutMode(previous);
    connect.mockRestore();
    await pool.end();
  }
});
