import type { Pool } from 'pg';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { DATASET, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

export function relayHandoffFixture(history = 1) {
  const state = { acknowledged: history, epoch: 'epoch', scope: MAIN_RELAY_STREAM_SCOPE,
    routing: 'routing', missing: new Set<number>(), partial: new Set<number>(), excess: new Set<number>(),
    completeEvents: new Set<number>() };
  const stats = { statements: 0, rows: 0, headers: 0 };
  const queries: string[] = [];
  const header = (sequence: number) => ({ stream_scope: state.scope, data_epoch: state.epoch,
    sequence: String(sequence), batch_id: `batch-${sequence}`, routing_epoch: state.routing,
    event_count: state.partial.has(sequence) || state.completeEvents.has(sequence) ? 1 : 0,
    actual_count: state.excess.has(sequence) || state.completeEvents.has(sequence) ? '1' : '0' });
  const ledger = { id: '', digest: '', state: 'running', disposition: null as string | null };
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql); stats.statements++;
    let rows: unknown[] = [];
    if (/^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT set_config)/.test(sql)) return { rows, rowCount: 0 };
    if (sql.includes('pg_try_advisory_lock')) rows = [{ locked: true }];
    else if (sql.includes('pg_advisory_unlock')) rows = [{ unlocked: true }];
    else if (sql.includes('FROM relay.owner_reconciliation r')) rows = [{ id: ledger.id, scope: 'reader',
      state: ledger.state, disposition: ledger.disposition }];
    else if (sql.includes('SELECT id, request_digest, state FROM relay.owner_reconciliation')) {
      rows = ledger.id ? [{ id: ledger.id, request_digest: ledger.digest, state: ledger.state }] : [];
    } else if (sql.includes('INSERT INTO relay.owner_reconciliation\n')) {
      ledger.id = String(values[0]); ledger.digest = String(values[2]);
    } else if (sql.includes('INSERT INTO relay.owner_reconciliation_item')) {
      ledger.disposition = sql.includes("'gap'") ? 'gap' : 'rebuilt';
    } else if (sql.includes('UPDATE relay.owner_reconciliation SET state')) {
      ledger.state = sql.includes("'held'") ? 'held' : 'reconciled';
    } else if (sql.includes('INSERT INTO relay.owner_reconciliation_cut')) { /* owner cut */ }
    else if (sql.includes('FROM relay.checkpoint')) {
      const filtered = sql.includes('WHERE stream_scope = $1 AND data_epoch = $2')
        && (values[0] !== state.scope || values[1] !== state.epoch);
      rows = filtered ? [] : [{ stream_scope: state.scope, data_epoch: state.epoch,
        sequence: String(state.acknowledged), routing_epoch: state.routing }];
    } else if (sql.includes('minimum_sequence')) rows = [{ minimum_sequence: '1', newest_delivered_sequence: String(history) }];
    else if (sql.includes('SELECT 1 FROM relay.delivered_event')) return { rows: [], rowCount: 0 };
    else if (sql.includes('FROM relay.delivered_batch AS batch')) {
      if (sql.includes('batch.sequence = $3::numeric')) {
        const sequence = Number(values[2]);
        rows = state.missing.has(sequence) ? [] : [header(sequence)];
      } else if (sql.trimEnd().endsWith('ORDER BY batch.sequence LIMIT 1')) {
        const after = Number(values[2]), through = Number(values[3]);
        rows = Array.from({ length: history }, (_, i) => i + 1)
          .filter(sequence => sequence > after && sequence <= through && !state.missing.has(sequence)).slice(0,1).map(header);
      } else {
        const after = Number(values[1]), through = Number(values[2] ?? history);
        rows = Array.from({ length: history }, (_, i) => i + 1)
          .filter(sequence => sequence > after && sequence <= through && !state.missing.has(sequence))
          .slice(0, sql.includes('LIMIT 1000') ? 1000 : Number(values[3] ?? 100)).map(header);
      }
      stats.headers += rows.length;
    } else if (sql.includes('count(*)::text AS actual_count FROM relay.delivered_event')) {
      const sequence = Number(values[2]);
      rows = [{ actual_count: state.excess.has(sequence) || state.completeEvents.has(sequence) ? '1' : '0' }];
    } else if (sql.includes('FROM relay.delivered_event')) {
      const sequence = Number(sql.includes('source = $2') ? values[3] : values[2]);
      rows = state.completeEvents.has(sequence) ? [{ stream_scope: state.scope, data_epoch: state.epoch,
        event_id: `event-${sequence}`, envelope: { specversion: '1.0', id: `event-${sequence}`,
          source: 'https://rezics.com/services/main', type: 'com.rezics.work.created.v1', data: {
            batchId: `batch-${sequence}`, routingEpoch: state.routing, ordinal: 0,
            sourcePosition: { datasetId: 'product', dataEpoch: state.epoch, sequence: String(sequence) },
            receipt: {}, relayPosition: { streamScope: state.scope, dataEpoch: state.epoch, sequence: String(sequence) },
          } } }] : [];
    }
    else throw new Error(`Unexpected retained handoff SQL: ${sql}`);
    stats.rows += rows.length;
    return { rows, rowCount: rows.length };
  };
  const relay = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const accessPosition = { sequence: '0' };
  const accessQuery = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT data_epoch, sequence::text FROM access.owner_consumer_checkpoint')) {
      return { rows: [{ data_epoch: state.epoch, sequence: accessPosition.sequence }], rowCount: 1 };
    }
    if (sql.includes('UPDATE access.owner_consumer_checkpoint')) {
      if (!sql.includes('SET sequence = $2') || values.length !== 2) throw new Error('Unexpected product checkpoint update');
      accessPosition.sequence = String(values[1]);
    }
    return { rows: [], rowCount: 1 };
  };
  const access = { query: accessQuery, connect: async () => ({ query: accessQuery, release() {} }) } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: { query: async (sql: string) => {
    if (sql.includes('SELECT ?sequence')) return { results: { bindings: [{ sequence: { value: '10' },
      relaySequence: { value: String(state.acknowledged) } }] } };
    if (sql.includes('SELECT ?controlSequence')) return { results: { bindings: [{ controlSequence: { value: String(history) },
      routing: { value: 'routing' } }] } };
    if (sql.includes(DATASET) || sql.includes('SELECT ?epoch ?prior') || sql.includes('SELECT DISTINCT ?realm ?work')) {
      return { results: { bindings: [] } };
    }
    throw new Error(`Unexpected handoff graph query: ${sql}`);
  } } } as unknown as WorkActivationEnvironment;
  return { relay, access, accessPosition, env, state, stats, queries, ledger,
    resetStats() { stats.statements = 0; stats.rows = 0; stats.headers = 0; } };
}
