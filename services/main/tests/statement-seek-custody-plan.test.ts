import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { PostgresReceiptCustodyStore, type CustodiedReceipt } from '../src/modules/outbox/receipt-custody.ts';
import { STATEMENT_CUSTODY_POSITION_SQL, STATEMENT_SEEK_COST } from '../src/modules/statement/seek.ts';

type Plan = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string;
  'Index Cond'?: string; 'Actual Rows'?: number; 'Rows Removed by Filter'?: number; Plans?: Plan[] };
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
const migration = (name: string) => readFileSync(new URL(`../migrations/access/${name}`, import.meta.url), 'utf8');

test('custody graph positions backfill atomically and seek an indexed neighbourhood at N and 16N history', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1000 });
  try {
    await pool.query('CREATE SCHEMA access');
    for (const file of ['1765_receipt_custody.sql', '1766_receipt_custody_delivery.sql',
      '1786_command_custody_erasure.sql']) await pool.query(migration(file));
    // Retained terminal metadata survives payload erasure and must be backfilled
    // without reopening or modifying the erased receipt.
    await pool.query(`INSERT INTO access.command_custody
      (receipt,request_digest,payload_sha256,payload,revision,terminal,outbox,reconciled_at,
       data_epoch,stream_sequence,payload_erasure_id,payload_erasure_epoch)
      VALUES ('urn:erased',repeat('a',64),repeat('b',64),NULL,'urn:erased-revision',
       '{"sequence":"64","streamSequence":"7"}',
       '{"graphSequence":"64","sequence":"7","batchId":"urn:erased-batch"}',
       clock_timestamp(),'erased',7,'00000000-0000-4000-8000-000000000001',1)`);
    await pool.query(migration('1787_receipt_custody_graph_position.sql'));
    expect((await pool.query(STATEMENT_CUSTODY_POSITION_SQL, ['erased', ['64'], 2])).rows)
      .toEqual([{ graph_sequence: '64', stream_sequence: '7', receipt: 'urn:erased', batch_id: 'urn:erased-batch' }]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const store = new PostgresReceiptCustodyStore(pool);
      await store.withReceipt('urn:atomic', async session => {
        await session.prepare({ receipt: 'urn:atomic', requestDigest: 'a'.repeat(64),
          payloadSha256: 'b'.repeat(64), payload: new Uint8Array([1]), revision: 'urn:atomic-revision',
          terminal: null, outbox: null, reconciled: false, retired: false });
        expect((await client.query('SELECT graph_sequence FROM access.command_custody WHERE receipt=$1', ['urn:atomic']))
          .rows[0]?.graph_sequence).toBeNull();
        await session.reconcile({ dataEpoch: 'atomic', sequence: '64', streamSequence: '7' } as CustodiedReceipt,
          { graphSequence: '64', sequence: '7', batchId: 'urn:atomic-batch' });
        expect(await store.receiptAt('atomic', '7', client)).toBe('urn:atomic');
        expect((await client.query(STATEMENT_CUSTODY_POSITION_SQL, ['atomic', ['64'], 2])).rows[0]?.graph_sequence).toBe('64');
      }, client);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect((await pool.query(STATEMENT_CUSTODY_POSITION_SQL, ['atomic', ['64'], 2])).rows).toEqual([]);

    let prior = 0;
    for (const retained of [4096, 65536]) {
      await pool.query(`INSERT INTO access.command_custody
        (receipt,request_digest,payload_sha256,payload,revision,terminal,outbox,reconciled_at,data_epoch,stream_sequence)
        SELECT 'urn:history:'||g,repeat('a',64),repeat('b',64),'\\x01'::bytea,'urn:revision:'||g,
          jsonb_build_object('sequence',g::text,'streamSequence',(g+100000)::text),
          jsonb_build_object('graphSequence',g::text,'sequence',(g+100000)::text,'batchId','urn:batch:'||g),
          clock_timestamp(),'history',g+100000 FROM generate_series($1::integer,$2::integer) g`, [prior+1,retained]);
      await pool.query('ANALYZE access.command_custody');
      const positions = Array.from({ length: STATEMENT_SEEK_COST.projectionSequences }, (_, i) => String(retained-i));
      const explain = (await pool.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${STATEMENT_CUSTODY_POSITION_SQL}`,
        ['history', positions, positions.length+1])).rows[0]!['QUERY PLAN'][0]!.Plan;
      const all = nodes(explain);
      expect(all.some(node => node['Node Type'] === 'Seq Scan'), JSON.stringify(explain)).toBe(false);
      const index = all.find(node => node['Index Name'] === 'command_custody_graph_position');
      expect(index, JSON.stringify(explain)).toBeDefined();
      expect(index!['Index Cond']).toContain('data_epoch');
      expect(index!['Index Cond']).toContain('graph_sequence');
      expect(index!['Actual Rows']).toBe(64);
      for (const scan of all.filter(node => node['Relation Name'] === 'command_custody')) {
        expect((scan['Actual Rows'] ?? 0) + (scan['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(64);
      }
      const rows = (await pool.query(STATEMENT_CUSTODY_POSITION_SQL, ['history', positions, positions.length+1])).rows;
      expect(rows).toHaveLength(64);
      expect(rows.every(row => BigInt(row.stream_sequence) === BigInt(row.graph_sequence)+100000n)).toBe(true);
      prior = retained;
    }
  } finally {
    await pool.end();
    cluster.remove();
  }
}, 60_000);
