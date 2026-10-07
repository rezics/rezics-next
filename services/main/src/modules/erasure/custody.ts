import type { Pool, PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { ObjectRecoveryStore } from '../owner/object-coverage.ts';
import type { ReceiptCustody } from '../outbox/receipt-custody.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
import { readExactModelGeneration } from '../semantic/model-custody.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import type { HeldGraphErasureReplay } from './graph.ts';
import { protectedObjectDigests } from './replay-objects.ts';

export interface RestoredGraphCustody {
  fuseki: FusekiClient;
  lineage: { dataEpoch: string; routingEpoch: string };
  receiptCustody?: Pick<ReceiptCustody, 'readHistorical'>;
  /** The outer owner qualifies the saved cut; originals come from its independent current source. */
  heldErasure?: Omit<HeldGraphErasureReplay, 'revisionIds' | 'original' | 'assertCurrent'> & {
    originalGraph: Pick<RestoredGraphCustody, 'fuseki' | 'lineage'>;
  };
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
