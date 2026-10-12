import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';
import { createHash } from 'node:crypto';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { newCost } from '../src/modules/structure/tree.ts';

export const serialId = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const serialWork = serialId(1);
const term = (value: string) => ({ type: 'uri', value });

/** Independent retained relay, Access materialization and live graph owners. */
export function selectedSerialFixture() {
  const state = { relayHead: '3', checkpoint: '3', checkpointEpoch: 'epoch', scope: MAIN_RELAY_STREAM_SCOPE,
    relayEpoch: 'epoch', retained: true, projected: true, projectedHead: serialId(5), currentHead: serialId(5),
    draftHead: serialId(5), graphCut: '40', bodySequence: '30', bodyEpoch: 'epoch', publication: serialId(8), savedPublication: serialId(8),
    eligibility: serialId(9), savedEligibility: serialId(9), revision: serialId(10), savedRevision: serialId(10),
    count: 2, children: 2, advanceDuringAccess: false };
  const publication = serialId(50);
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
      structure_head: state.projectedHead, publication_head: publication, chapter_count: state.count, word_count: '480',
      last_updated_at: new Date('2026-10-01T00:00:00Z') }] };
  } } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid/serial');
  graph.query = async query => ({ results: { bindings: query.includes('SELECT ?work ?head')
    ? [{ work: term(serialWork), head: term(query.includes('rv:workStructurePublicationHead')
      ? state.currentHead : state.draftHead), publication: term(publication) }]
    : Array.from({ length: state.children }, (_, n) => ({ occurrence: term(serialId(20 + n)), variant: term(serialId(40 + n)),
      revision: term(state.revision), publication: term(state.publication), eligibility: term(state.eligibility),
      epoch: term(state.bodyEpoch), sequence: term(state.bodySequence), public: term('true') })) } });
  const env = { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as WorkActivationEnvironment;
  return { state, access, relay, graph, env, projection: new SerialStatisticsProjection(access, relay, {} as Pool, env) };
}

/** Real immutable owner objects keep published membership separate from the live draft. */
export async function publishedSerialStructure(count: number) {
  const structure = serialId(3), main = serialId(2), head = serialId(5), generation = serialId(6);
  const publication = serialId(50), admission = '00000000-0000-4000-8000-000000000051';
  const retained = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async bytes => { const digest = createHash('sha256').update(bytes).digest('hex');
      retained.set(digest, bytes.slice()); return digest; },
    get: async digest => { const bytes = retained.get(digest);
      if (!bytes) throw new Error('Missing immutable publication fixture'); return bytes.slice(); },
  };
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, n) => ({
    occurrence: serialId(20 + n), state: 'active', parent: structure, segmentKey: 'a', orderKey: String(n),
    role: 'chapter', target: serialId(30 + n), labels: [], introducedBy: head,
  }));
  const cost = newCost(), rt = recordTree(objects), ot = orderTree(objects);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: main,
    profile: 'book-composition', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await rt.apply(await rt.empty(cost), new Map(records.map(r => [r.occurrence, r])), cost),
    order: await ot.apply(await ot.empty(cost), new Map(records.map(r => {
      const entry = { parent: r.parent, segmentKey: r.segmentKey!, orderKey: r.orderKey!, occurrence: r.occurrence };
      return [orderTreeKey(entry), entry];
    })), cost), placementCount: count, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const state = { liveHead: head, selectedHead: head, selectedPublication: publication };
  const graph = new FusekiClient('http://graph.invalid/selected-structure');
  graph.query = async query => {
    const rows = query.includes('SELECT ?work ?main ?head') ? [{ work: term(serialWork), main: term(main),
      head: term(state.selectedHead), generation: term(generation), publication: term(state.selectedPublication),
      admission: term(admission) }]
      : query.includes('SELECT ?component ?profile') ? [{ component: term(main),
        profile: term(structureProfileFor('book-composition').graphProfile), head: term(state.liveHead),
        generation: term(generation), count: term(String(count)), manifest: term(`urn:rezics:sha256:${digest}`) }]
      : query.includes('SELECT ?owner') ? [{ owner: term(serialWork) }]
      : query.includes('SELECT ?manifest') ? [{ manifest: term(`urn:rezics:sha256:${digest}`),
        count: term(String(count)), epoch: term('epoch'), sequence: term('3') }]
      : query.includes('SELECT ?occurrence ?chapter') ? records.map(r => ({ occurrence: term(r.occurrence),
        chapter: term(r.target!) })) : [];
    return { results: { bindings: rows } };
  };
  const env = { fuseki: graph, structureObjects: objects, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as unknown as WorkActivationEnvironment;
  return { env, graph, state, structure, main, head, generation, publication, records };
}
