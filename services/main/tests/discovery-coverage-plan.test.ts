import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { DiscoveryRefreshInputs } from '../src/modules/discovery/source.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';

type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Subplan Name'?: string;
  'Actual Loops': number;
  'Actual Rows': number;
  'Rows Removed by Filter'?: number;
  'Index Cond'?: string;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  Plans?: Plan[];
};
type Explanation = { Plan: Plan; 'Execution Time': number };
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

// The former production statement remains an executable control for the growth
// measurement; only productionStatement below determines the regression gate.
const legacyStatement = `WITH coverage AS (
        SELECT c.stream_scope,c.data_epoch,c.sequence::text AS sequence,
          COALESCE((SELECT max(b.sequence) FROM relay.delivered_batch b
            WHERE b.stream_scope=c.stream_scope AND b.data_epoch=c.data_epoch
              AND b.sequence <= c.sequence AND EXISTS (
                SELECT 1 FROM relay.delivered_event e
                WHERE e.stream_scope=b.stream_scope AND e.data_epoch=b.data_epoch AND e.sequence=b.sequence
                  AND e.source='https://rezics.com/services/main'
                  AND e.envelope #>> '{data,sourcePosition,datasetId}'='product'
                  AND e.envelope #>> '{data,sourcePosition,dataEpoch}'=c.data_epoch
                  AND e.envelope #>> '{data,sourcePosition,sequence}' ~ '^(0|[1-9][0-9]{0,99})$'
                  AND (e.envelope #>> '{data,sourcePosition,sequence}')::numeric <= $5::numeric
              )),0)::text AS after_sequence
        FROM relay.checkpoint c
        WHERE c.consumer=$1 AND c.stream_scope=$2 AND c.data_epoch=$3 AND c.sequence >= $4::numeric
      )
      SELECT coverage.after_sequence,coverage.stream_scope AS coverage_stream_scope,
        coverage.data_epoch AS coverage_data_epoch,coverage.sequence AS coverage_sequence,
        b.stream_scope,b.data_epoch,b.sequence::text,b.batch_id,b.routing_epoch,b.event_count,
        e.event_id,e.envelope
      FROM coverage
      LEFT JOIN relay.delivered_batch b ON b.stream_scope=coverage.stream_scope
        AND b.data_epoch=coverage.data_epoch AND b.sequence > coverage.after_sequence::numeric
        AND b.sequence <= coverage.sequence::numeric
      LEFT JOIN relay.delivered_event e ON e.stream_scope=b.stream_scope
        AND e.data_epoch=b.data_epoch AND e.sequence=b.sequence
      ORDER BY b.sequence,e.event_id LIMIT $6`;

// Capture the statement actually executed by the reader, rather than maintaining
// a second optimized query which could pass while production regresses.
async function productionStatement(retained: number) {
  let statement = '', parameters: unknown[] = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    statement = sql;
    parameters = values;
    return { rows: [] };
  } } as unknown as Pool;
  await new DiscoveryRefreshInputs(pool, 'coverage-plan').read({
    streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'history', sequence: String(retained),
  }, { dataEpoch: 'history', sequence: String((retained - 64) * 3) });
  return { statement, parameters };
}

test('discovery coverage probes remain bounded at 1,000 / 4,000 / 16,000 retained batches', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 1 });
  try {
    for (const name of ['001_delivery.sql', '002_coverage_scan.sql', '003_retained_batches.sql',
      '020_main_stream_scope.sql', '024_batch_graph_sequence.sql', '025_legacy_batch_graph_sequence.sql']) {
      await pool.query(readFileSync(new URL(`../migrations/relay/${name}`, import.meta.url), 'utf8'));
    }
    await pool.query("INSERT INTO relay.checkpoint (consumer,data_epoch) VALUES ('coverage-plan','history')");
    const measurements: { retained: number; buffers: number; milliseconds: number; plan: Plan }[] = [];
    const legacyBuffers: number[] = [];
    let previous = 0;
    for (const retained of [1000, 4000, 16000]) {
      await pool.query(`INSERT INTO relay.delivered_batch
        (data_epoch,sequence,batch_id,routing_epoch,event_count,graph_sequence)
        SELECT 'history',g,'batch-'||g,'routing',1,g*3
        FROM generate_series($1::integer,$2::integer) g`, [previous + 1, retained]);
      await pool.query(`INSERT INTO relay.delivered_event (source,event_id,data_epoch,sequence,envelope)
        SELECT 'https://rezics.com/services/main','event-'||g,'history',g,
          jsonb_build_object('specversion','1.0','id','event-'||g,'source','https://rezics.com/services/main',
            'data',jsonb_build_object('batchId','batch-'||g,'routingEpoch','routing','ordinal',0,
              'sourcePosition',jsonb_build_object('datasetId','product','dataEpoch','history','sequence',(g*3)::text),
              'receipt',jsonb_build_object('action','work.create','outcome','succeeded',
                'work','https://rezics.com/id/00000000-0000-4000-8000-000000000001')))
        FROM generate_series($1::integer,$2::integer) g`, [previous + 1, retained]);
      await pool.query("UPDATE relay.checkpoint SET sequence=$1 WHERE consumer='coverage-plan'", [retained]);
      await pool.query('ANALYZE relay.delivered_batch');
      await pool.query('ANALYZE relay.delivered_event');
      const { statement, parameters } = await productionStatement(retained);
      const explanation = (await pool.query<{ 'QUERY PLAN': Explanation[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${statement}`, parameters))
        .rows[0]!['QUERY PLAN'][0]!;
      const buffers = explanation.Plan['Shared Hit Blocks'] + explanation.Plan['Shared Read Blocks'];
      measurements.push({ retained, buffers, milliseconds: explanation['Execution Time'], plan: explanation.Plan });
      const lookup = nodes(explanation.Plan).find(node => node['Node Type'] === 'Limit'
        && node.Plans?.some(child => child['Relation Name'] === 'delivered_batch'));
      console.info(JSON.stringify({ discoveryCoverage: { retained, buffers,
        sharedHits: explanation.Plan['Shared Hit Blocks'], sharedReads: explanation.Plan['Shared Read Blocks'],
        lookupBuffers: lookup && lookup['Shared Hit Blocks'] + lookup['Shared Read Blocks'],
        milliseconds: explanation['Execution Time'] } }));
      expect(lookup, JSON.stringify(explanation)).toBeDefined();
      expect(lookup!['Actual Loops']).toBe(1);
      expect(explanation.Plan['Actual Rows']).toBe(64);
      const legacy = (await pool.query<{ 'QUERY PLAN': Explanation[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${legacyStatement}`, parameters))
        .rows[0]!['QUERY PLAN'][0]!;
      legacyBuffers.push(legacy.Plan['Shared Hit Blocks'] + legacy.Plan['Shared Read Blocks']);
      console.info(JSON.stringify({ legacyDiscoveryCoverage: { retained, buffers: legacyBuffers.at(-1),
        milliseconds: legacy['Execution Time'] } }));
      previous = retained;
    }
    for (const measurement of measurements) {
      expect(measurement.buffers).toBeLessThan(4096);
      expect(nodes(measurement.plan).filter(node => node['Relation Name'] === 'delivered_event')
        .every(node => node['Actual Rows'] * node['Actual Loops'] <= 65)).toBe(true);
    }
    expect(legacyBuffers[2]!).toBeGreaterThan(legacyBuffers[0]! * 8);
    expect(measurements[2]!.buffers).toBeLessThanOrEqual(measurements[0]!.buffers * 2);

    const inputs = new DiscoveryRefreshInputs(pool, 'coverage-plan');
    const coverage = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'history', sequence: '16000' };
    const after = { dataEpoch: 'history', sequence: String(15936 * 3) };
    const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
    expect(await inputs.read(coverage, after)).toEqual({ works: [work], created: [work] });
    expect(await inputs.read(coverage, { ...after, sequence: '48000' })).toEqual({ works: [], created: [] });
    expect(await inputs.read(coverage, { ...after, sequence: '45000' })).toEqual({ works: [work], created: [work] });
    expect(await inputs.read(coverage, { ...after, sequence: '44997' })).toBeNull();
    expect(await inputs.read({ ...coverage, sequence: '15999' }, after)).toBeNull();
    expect(await inputs.read(coverage, { ...after, dataEpoch: 'restored' })).toBeNull();
    expect(await inputs.read({ ...coverage, streamScope: 'other' }, after)).toBeNull();

    async function isolated(change: string, check: () => Promise<void>) {
      await pool.query('BEGIN');
      try { await pool.query(change); await check(); }
      finally { await pool.query('ROLLBACK'); }
    }
    await isolated('UPDATE relay.delivered_batch SET graph_sequence=NULL WHERE sequence=1', async () => {
      await expect(inputs.read(coverage, after)).rejects.toBeInstanceOf(WorkReadUnavailable);
      await expect(inputs.read(coverage, after)).rejects.toThrow('task main:relay -- --repair-graph-cuts');
      await pool.query('UPDATE relay.delivered_batch SET graph_sequence=3 WHERE sequence=1');
      expect(await inputs.read(coverage, after)).toEqual({ works: [work], created: [work] });
    });
    await isolated(`UPDATE relay.delivered_event SET envelope=jsonb_set(envelope,
      '{data,sourcePosition,datasetId}','"other"') WHERE sequence=15936`, async () => {
      expect(await inputs.read(coverage, after)).toBeNull();
    });
    await isolated(`DELETE FROM relay.delivered_batch WHERE sequence=15999`, async () => {
      expect(await inputs.read(coverage, after)).toBeNull();
    });
    await isolated(`DELETE FROM relay.delivered_event WHERE sequence=15999`, async () => {
      expect(await inputs.read(coverage, after)).toBeNull();
    });
    await isolated(`UPDATE relay.delivered_event SET envelope=jsonb_set(envelope,
      '{data,receipt,action}','"future.unclassified"') WHERE sequence=16000`, async () => {
      expect(await inputs.read(coverage, after)).toBeNull();
    });
    await isolated(`DELETE FROM relay.delivered_event WHERE sequence>15936;
      UPDATE relay.delivered_batch SET event_count=0 WHERE sequence>15936`, async () => {
      expect(await inputs.read(coverage, after)).toEqual({ works: [], created: [] });
    });
    await isolated(`DELETE FROM relay.delivered_event;
      UPDATE relay.delivered_batch SET event_count=0`, async () => {
      const { statement, parameters } = await productionStatement(16000);
      const explanation = (await pool.query<{ 'QUERY PLAN': Explanation[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${statement}`, parameters))
        .rows[0]!['QUERY PLAN'][0]!;
      const boundary = nodes(explanation.Plan).find(node => node['Node Type'] === 'Limit'
        && node.Plans?.some(child => child['Relation Name'] === 'delivered_batch'));
      expect(boundary, JSON.stringify(explanation)).toBeDefined();
      expect(boundary!['Actual Loops']).toBe(1);
      expect(boundary!['Shared Hit Blocks'] + boundary!['Shared Read Blocks']).toBeLessThan(4096);
      const probe = boundary!.Plans![0]!;
      expect(probe['Index Name']).toBe('delivered_batch_pkey');
      expect(probe['Index Cond']).toContain('sequence >=');
      expect(probe['Actual Rows'] + (probe['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(1001);
      expect(await inputs.read(coverage, after)).toBeNull();
    });
  } finally {
    await pool.end();
    cluster.remove();
  }
}, 120_000);
