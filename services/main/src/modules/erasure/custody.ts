import type { Pool } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { ObjectRecoveryStore } from '../owner/object-coverage.ts';
import type { ReceiptCustody } from '../outbox/receipt-custody.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
import { readExactModelGeneration } from '../semantic/model-custody.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { protectedObjectDigests } from './replay-objects.ts';

export interface RestoredGraphCustody {
  fuseki: FusekiClient;
  lineage: { dataEpoch: string; routingEpoch: string };
  receiptCustody?: Pick<ReceiptCustody, 'read'>;
}

/** Offline owner checks reuse C6's exact readers; current build bytes cannot repair a legacy gap. */
export async function restoredCustodyDigests(access: Pool, graph: RestoredGraphCustody,
  objects: ObjectRecoveryStore): Promise<Set<string>> {
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
    await readExactModelGeneration(env, generation);
  }
  // Retired slim proofs no longer appear in the graph's object-reference scan.
  // The owner position reader rechecks durable terminal/outbox AND exact objects.
  after = '';
  for (;;) {
    const rows = (await access.query<{ receipt: string; payload_sha256: string; data_epoch: string | null;
      stream_sequence: string | null; graph_sequence: string | null }>(`SELECT receipt, data_epoch,
        payload_sha256, stream_sequence::text AS stream_sequence, terminal->>'sequence' AS graph_sequence
      FROM access.command_custody WHERE receipt > $1 ORDER BY receipt LIMIT 100`, [after])).rows;
    for (const row of rows) {
      if (!row.data_epoch || !row.stream_sequence || !row.graph_sequence || !graph.receiptCustody) {
        throw new Error('retained command custody is unavailable');
      }
      const exact = await graph.receiptCustody.read(row.data_epoch, row.stream_sequence);
      if (!exact || exact.batch.custodiedReceipt !== row.receipt
        || exact.batch.streamScope !== MAIN_RELAY_STREAM_SCOPE
        || exact.batch.dataEpoch !== row.data_epoch || exact.batch.sequence !== row.stream_sequence
        || exact.batch.graphSequence !== row.graph_sequence) {
        throw new Error('retained command custody differs from its owner position');
      }
      // Object erasure must also preserve commands whose native proof was retired.
      retained.add(row.payload_sha256);
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.receipt;
  }
  return retained;
}
