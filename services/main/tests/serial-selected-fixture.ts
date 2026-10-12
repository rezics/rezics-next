import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';

export const serialId = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const serialWork = serialId(1);
const term = (value: string) => ({ type: 'uri', value });

/** Independent retained relay, Access materialization and live graph owners. */
export function selectedSerialFixture() {
  const state = { relayHead: '3', checkpoint: '3', checkpointEpoch: 'epoch', scope: MAIN_RELAY_STREAM_SCOPE,
    relayEpoch: 'epoch', retained: true, projected: true, projectedHead: serialId(5), currentHead: serialId(5),
    graphCut: '40', bodySequence: '30', bodyEpoch: 'epoch', publication: serialId(8), savedPublication: serialId(8),
    eligibility: serialId(9), savedEligibility: serialId(9), revision: serialId(10), savedRevision: serialId(10),
    count: 2, children: 2, advanceDuringAccess: false };
  const relay = { query: async (sql: string) => sql.includes('max(sequence)')
    ? { rows: [{ stream_scope: state.scope, data_epoch: state.relayEpoch, sequence: state.relayHead }] }
    : { rows: state.retained ? [{ graph_sequence: state.graphCut }] : [] } } as unknown as Pool;
  const access = { query: async (sql: string) => {
    if (sql.includes('FROM access.serial_chapter')) return { rows: Array.from({ length: state.children }, (_, n) => ({
      work: serialWork, occurrence: serialId(20 + n), resource: serialId(30 + n), variant: serialId(40 + n),
      revision: state.savedRevision, publication: state.savedPublication, eligibility: state.savedEligibility })) };
    if (state.advanceDuringAccess) state.checkpoint = '4';
    return { rows: [{ generation: 'generation', graph_epoch: state.checkpointEpoch, sequence: state.checkpoint,
      work: state.projected ? serialWork : null, main_version: serialId(2), structure: serialId(3),
      structure_head: state.projectedHead, chapter_count: state.count, word_count: '480',
      last_updated_at: new Date('2026-10-01T00:00:00Z') }] };
  } } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid/serial');
  graph.query = async query => ({ results: { bindings: query.includes('SELECT ?work ?head')
    ? [{ work: term(serialWork), head: term(state.currentHead) }]
    : Array.from({ length: state.children }, (_, n) => ({ occurrence: term(serialId(20 + n)), variant: term(serialId(40 + n)),
      revision: term(state.revision), publication: term(state.publication), eligibility: term(state.eligibility),
      epoch: term(state.bodyEpoch), sequence: term(state.bodySequence), public: term('true') })) } });
  const env = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as WorkActivationEnvironment;
  return { state, access, relay, graph, env, projection: new SerialStatisticsProjection(access, relay, {} as Pool, env) };
}
