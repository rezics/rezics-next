import type { Pool, PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { ObjectRecoveryStore } from '../owner/object-coverage.ts';
import type { HistoricalReceiptSource } from '../outbox/receipt-custody.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
import { readExactModelGeneration } from '../semantic/model-custody.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import { GraphErasureUnavailable, graphErasureReceipt,
  type GraphSuppressionProof, type HeldGraphErasureReplay } from './graph.ts';
import { protectedObjectDigests } from './replay-objects.ts';

export interface RestoredGraphCustody {
  fuseki: FusekiClient;
  lineage: { dataEpoch: string; routingEpoch: string };
  receiptCustody?: {
    readHistorical(position: { dataEpoch: string; streamSequence: string }, accessClient: PoolClient):
      Promise<Pick<HistoricalReceiptSource, 'outbox' | 'objectDigests'> | null>;
  };
  /** The outer owner qualifies the saved cut and selects an independently retained original source. */
  heldErasure?: Omit<HeldGraphErasureReplay, 'revisionIds' | 'original' | 'assertCurrent'> & (
    | { originalSource: 'original-graph'; originalGraph: Pick<RestoredGraphCustody, 'fuseki' | 'lineage'> }
    | { originalSource: 'retained-native-event'; originalGraph?: never }
  );
}

export interface RetainedNativeGraphSuppressionSource {
  original: GraphSuppressionProof;
  /** Verified event/header facts; an existing reconciliation can bind this
   * digest, but release still rereads the exact independently retained source. */
  evidenceDigest: string;
}

function nativeEventFields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

/** One native event primary-key lookup, its header and at most two indexed sibling events.
 * Native-writer retention is the trust boundary, not a signature on this envelope.
 * Relay's insert-only writer preserves these facts; share locks stabilize this read.
 * The outer restore owns the allocator lock and READ COMMITTED transaction.
 * This reader never connects, changes transaction lifecycle or consults a graph.
 */
export async function readRetainedNativeGraphSuppressionProof(relayClient: PoolClient,
  erasureId: string, epoch: string, revisionIds: readonly string[]): Promise<RetainedNativeGraphSuppressionSource> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(erasureId) || !/^[1-9][0-9]{0,18}$/.test(epoch)
    || !revisionIds.length || revisionIds.length > 64
    || new Set(revisionIds).size !== revisionIds.length || revisionIds.some(id => !uuid.test(id))) {
    throw new GraphErasureUnavailable('retained native erasure proof input is invalid');
  }
  const source = 'https://rezics.com/services/main';
  const receipt = graphErasureReceipt(erasureId);
  const eventId = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const batchId = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const targets = [...revisionIds].sort().map(id => `urn:rezics:content:revision:${id}`);
  const requestDigest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId, epoch, targets }));
  const rows = (await relayClient.query<{ stream_scope: string; source: string; event_id: string;
    data_epoch: string; sequence: string; envelope: unknown; batch_id: string; routing_epoch: string;
    event_count: number; batch_scope: string; batch_epoch: string; batch_sequence: string; actual_count: string }>(
    `SELECT event.stream_scope, event.source, event.event_id, event.data_epoch,
       event.sequence::text AS sequence,
       CASE WHEN octet_length(event.envelope::text) <= 16384 THEN event.envelope END AS envelope,
       batch.batch_id, batch.routing_epoch, batch.event_count,
       batch.stream_scope AS batch_scope, batch.data_epoch AS batch_epoch,
       batch.sequence::text AS batch_sequence, inventory.actual_count
     FROM relay.delivered_event AS event JOIN relay.delivered_batch AS batch
       ON batch.stream_scope = event.stream_scope AND batch.data_epoch = event.data_epoch
         AND batch.sequence = event.sequence
     CROSS JOIN LATERAL (
       SELECT count(*)::text AS actual_count FROM (
         SELECT 1 FROM relay.delivered_event AS sibling
         WHERE sibling.stream_scope = event.stream_scope AND sibling.data_epoch = event.data_epoch
           AND sibling.sequence = event.sequence LIMIT 2 FOR SHARE OF sibling
       ) AS bounded
     ) AS inventory
     WHERE event.stream_scope = $1 AND event.source = $2 AND event.event_id = $3
     LIMIT 2 FOR SHARE OF event, batch`, [MAIN_RELAY_STREAM_SCOPE, source, eventId])).rows;
  const row = rows[0], envelope = row?.envelope;
  if (rows.length !== 1 || !row
    || !nativeEventFields(envelope, ['specversion', 'id', 'source', 'type', 'datacontenttype', 'data'])) {
    throw new GraphErasureUnavailable('retained native erasure event or header is unavailable');
  }
  const data = envelope.data;
  if (!nativeEventFields(data, ['batchId', 'sourcePosition', 'routingEpoch', 'ordinal', 'receipt', 'relayPosition'])) {
    throw new GraphErasureUnavailable('retained native erasure event data differs');
  }
  const diagnostic = data.sourcePosition, main = data.relayPosition, terminal = data.receipt;
  if (!nativeEventFields(diagnostic, ['datasetId', 'dataEpoch', 'sequence'])
    || !nativeEventFields(main, ['streamScope', 'dataEpoch', 'sequence'])
    || !nativeEventFields(terminal, ['id', 'action', 'outcome', 'requestDigest', 'systemProof'])) {
    throw new GraphErasureUnavailable('retained native erasure positions or receipt differ');
  }
  const system = terminal.systemProof;
  if (!nativeEventFields(system, ['kind', 'erasureId', 'erasureEpoch'])
    || envelope.specversion !== '1.0' || envelope.id !== eventId || envelope.source !== source
    || envelope.type !== 'com.rezics.erasure.graph-suppressed.v1'
    || envelope.datacontenttype !== 'application/json'
    || row.stream_scope !== MAIN_RELAY_STREAM_SCOPE || row.source !== source || row.event_id !== eventId
    || row.batch_scope !== MAIN_RELAY_STREAM_SCOPE || row.batch_epoch !== row.data_epoch
    || row.batch_sequence !== row.sequence || row.batch_id !== batchId || row.event_count !== 1
    || row.actual_count !== '1'
    || typeof row.routing_epoch !== 'string' || row.routing_epoch.length === 0
    || typeof row.sequence !== 'string' || !/^[1-9][0-9]{0,99}$/.test(row.sequence)
    || data.batchId !== batchId || data.routingEpoch !== row.routing_epoch || data.ordinal !== 0
    || diagnostic.datasetId !== 'product' || typeof diagnostic.dataEpoch !== 'string'
    || !uuid.test(diagnostic.dataEpoch) || diagnostic.dataEpoch !== row.data_epoch
    || typeof diagnostic.sequence !== 'string' || !/^[1-9][0-9]*$/.test(diagnostic.sequence)
    || main.streamScope !== MAIN_RELAY_STREAM_SCOPE || main.dataEpoch !== row.data_epoch
    || main.sequence !== row.sequence
    || terminal.id !== receipt || terminal.action !== 'erasure.graph' || terminal.outcome !== 'succeeded'
    || terminal.requestDigest !== requestDigest || system.kind !== 'relay-erasure'
    || system.erasureId !== erasureId || system.erasureEpoch !== epoch) {
    throw new GraphErasureUnavailable('retained native erasure proof differs from its exact original');
  }
  return { original: { receipt, dataEpoch: diagnostic.dataEpoch, sequence: diagnostic.sequence },
    evidenceDigest: hash(JSON.stringify([row.stream_scope, row.source, row.event_id, row.data_epoch,
      row.sequence, row.batch_id, row.routing_epoch, row.event_count, envelope])) };
}

/** Offline owner checks reuse C6's exact readers; current build bytes cannot repair a legacy gap. */
export async function restoredCustodyDigests(access: Pool, graph: RestoredGraphCustody,
  objects: ObjectRecoveryStore, accessClient?: PoolClient): Promise<Set<string>> {
  if (!accessClient) {
    const owned = await access.connect();
    try { return await restoredCustodyDigests(access, graph, objects, owned); }
    finally { owned.release(); }
  }
  const retained = await protectedObjectDigests(graph.fuseki, objects);
  const env = { fuseki: graph.fuseki, lineage: graph.lineage, objectDirectory: objects.directory,
    ...(objects.workObjects ? { workObjects: objects.workObjects } : {}) };
  const generations = new Set<string>();
  let after = '';
  for (;;) {
    const rows = (await graph.fuseki.query(`PREFIX rv: <${RV}>
      SELECT DISTINCT ?generation WHERE {
        { GRAPH ${iri(GRAPHS.revisions)} { ?generation a rv:ModelGeneration } }
        UNION { GRAPH ${iri(GRAPHS.current)} { ?component a rv:ModelComponent ; rv:generationHead ?generation } }
        FILTER(STR(?generation) > ${JSON.stringify(after)})
      } ORDER BY ?generation LIMIT 100`, 65_536)).results?.bindings;
    if (!rows) throw new Error('retained model inventory is unavailable');
    for (const row of rows) {
      if (row.generation?.type !== 'uri') throw new Error('retained model identity is invalid');
      generations.add(row.generation.value);
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.generation!.value;
  }
  // A complete artifact inventory does not prove a revision's model pin exists.
  after = '';
  for (;;) {
    const rows = (await graph.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?revision (COUNT(?generation) AS ?count) (SAMPLE(?generation) AS ?generation)
      WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ?revision a rv:RevisionAnchor . FILTER(STR(?revision) > ${JSON.stringify(after)})
        FILTER NOT EXISTS { ?revision a rv:ModelGeneration }
        # These semantic families pin generations; Work metadata predates that contract.
        FILTER(EXISTS { ?revision rv:modelGeneration ?pin }
          || EXISTS { VALUES ?kind { rv:SemanticRevision rv:DefinitionRevision rv:FiniteRuleRevision
            rv:PresentationRevision rv:RelationOccurrenceRevision rv:RatingQuestionPresentationV2Revision }
            ?revision a ?kind })
        OPTIONAL { ?revision rv:modelGeneration ?generation }
      } } GROUP BY ?revision ORDER BY ?revision LIMIT 100`, 65_536)).results?.bindings;
    if (!rows) throw new Error('retained revision model inventory is unavailable');
    for (const row of rows) {
      if (row.revision?.type !== 'uri' || row.count?.value !== '1'
        || row.generation?.type !== 'uri') throw new Error('retained revision model pin is unavailable');
      generations.add(row.generation.value);
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.revision!.value;
  }
  for (const generation of generations) {
    const model = await readExactModelGeneration(env, generation);
    retained.add(model.manifestSha256);
    for (const shape of model.shapes) retained.add(shape.sha256);
  }
  // Retired slim proofs no longer appear in the graph's object-reference scan.
  // The owner position reader rechecks durable terminal/outbox AND exact objects.
  after = '';
  for (;;) {
    const rows = (await accessClient.query<{ receipt: string; payload_sha256: string; data_epoch: string | null;
      stream_sequence: string | null; graph_sequence: string | null }>(`SELECT receipt, data_epoch,
        payload_sha256, stream_sequence::text AS stream_sequence, terminal->>'sequence' AS graph_sequence
      FROM access.command_custody WHERE receipt > $1 ORDER BY receipt LIMIT 100`, [after])).rows;
    for (const row of rows) {
      if (!row.data_epoch || !row.stream_sequence || !row.graph_sequence || !graph.receiptCustody) {
        throw new Error('retained command custody is unavailable');
      }
      const exact = await graph.receiptCustody.readHistorical({ dataEpoch: row.data_epoch,
        streamSequence: row.stream_sequence }, accessClient);
      if (!exact || exact.outbox.batch.custodiedReceipt !== row.receipt
        || exact.outbox.batch.streamScope !== MAIN_RELAY_STREAM_SCOPE
        || exact.outbox.batch.dataEpoch !== row.data_epoch || exact.outbox.batch.sequence !== row.stream_sequence
        || exact.outbox.batch.graphSequence !== row.graph_sequence
        || !exact.objectDigests.has(row.payload_sha256)) {
        throw new Error('retained command custody differs from its owner position');
      }
      // Verify the selected restored copy even if the reader was bound to a live store.
      // Retired/superseded originals can be absent from every graph reference scan.
      for (const digest of exact.objectDigests) {
        if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('retained command custody digest is invalid');
        const bytes = objects.workObjects ? await objects.workObjects.get(digest)
          : await readFile(join(objects.directory, digest));
        if (hash(bytes) !== digest) {
          throw new Error('retained command custody object differs from its exact digest');
        }
        retained.add(digest);
      }
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.receipt;
  }
  return retained;
}
