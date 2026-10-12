import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { DiscoveryRefreshInputs } from '../src/modules/discovery/source.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';

type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Subplan Name'?: string;
  'Actual Loops': number;
  'Actual Rows': number;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  Plans?: Plan[];
};
type Explanation = { Plan: Plan; 'Execution Time': number };
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

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

test.failing('discovery coverage probes remain bounded at 1,000 / 4,000 / 16,000 retained batches', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 1 });
  try {
    for (const name of ['001_delivery.sql', '002_coverage_scan.sql', '003_retained_batches.sql',
      '020_main_stream_scope.sql', '024_batch_graph_sequence.sql', '025_legacy_batch_graph_sequence.sql']) {
      await pool.query(readFileSync(new URL(`../migrations/relay/${name}`, import.meta.url), 'utf8'));
    }
    await pool.query("INSERT INTO relay.checkpoint (consumer,data_epoch) VALUES ('coverage-plan','history')");
    const measurements: { retained: number; buffers: number; milliseconds: number; plan: Plan }[] = [];
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
      console.info(JSON.stringify({ discoveryCoverage: { retained, buffers, milliseconds: explanation['Execution Time'] } }));
      expect((await pool.query(statement, parameters)).rows).toHaveLength(64);
      previous = retained;
    }
    for (const measurement of measurements) {
      expect(measurement.buffers).toBeLessThan(4096);
      expect(nodes(measurement.plan).filter(node => node['Relation Name'] === 'delivered_event')
        .every(node => node['Actual Rows'] * node['Actual Loops'] <= 64)).toBe(true);
    }
    expect(measurements[2]!.buffers).toBeLessThanOrEqual(measurements[0]!.buffers * 2);
  } finally {
    await pool.end();
    cluster.remove();
  }
}, 120_000);
