import type { PoolClient } from 'pg';
import { BATCH_ENVELOPES } from '../events/log.ts';
import { completedLocatorSources, SEMANTIC_LOCATOR_ADVANCED } from '../semantic/erasure-locator-receipt.ts';
import type { DiscoveryTarget } from './account-discovery.ts';
import { discoveryConsumer } from './consumer-name.ts';
import type { DiscoveryCut } from './generations.ts';
import { discoveryIndexName } from './indices.ts';
import { SEARCH_IDENTITY_WRITER_CHANGED } from './identity-epoch-participant-events.ts';

/** Only mixed homes with a common positive certified source point can use this proof. */
export function maintenanceCutCandidates(cuts: readonly DiscoveryCut[]) {
  let remaining = BATCH_ENVELOPES;
  return cuts.filter((row) => {
    if (
      row.position === row.head ||
      row.position === '0' ||
      row.collection_epoch === null ||
      [row.semantic_position, row.collection_position, row.review_position, row.space_position].some(
        (position) => position !== row.position,
      )
    )
      return false;
    const span = BigInt(row.head) - BigInt(row.position);
    if (span < 1n || span > BigInt(remaining)) return false;
    remaining -= Number(span);
    return true;
  });
}

/** The real producers have just observed the proposed head. Recheck the exact received suffix and CAS all
 * five original certificates together. An unproved position leaves the ordinary reconciliation path intact. */
export async function advanceMaintenanceCuts(
  client: PoolClient,
  target: DiscoveryTarget,
  cuts: readonly DiscoveryCut[],
) {
  const { prefix, generation, uuid, incarnation } = target;
  const result = await client.query<{ partition: number }>(
    `WITH bound AS MATERIALIZED (
       SELECT generation FROM search.discovery_generation
       WHERE partition_no=0 AND prefix=$1 AND generation=$2 AND index_uuid=$3 AND incarnation=$4::uuid
         AND state IN ('reconciling','ready') FOR UPDATE
     ), input AS MATERIALIZED (
       SELECT i.* FROM bound, jsonb_to_recordset($5::jsonb) AS i(partition int,position bigint,head bigint,
         collection_epoch int,revision bigint,claim_revision bigint,semantic_revision bigint,semantic_claim_revision bigint)
     ), homes AS MATERIALIZED (
       SELECT i.* FROM input i JOIN core.partition h ON h.partition_no=i.partition AND h.write_state='active'
         AND h.epoch=i.collection_epoch AND h.position=i.head
       JOIN core.consumer_checkpoint cp ON cp.partition_no=h.partition_no AND cp.consumer=$6
         AND cp.epoch=h.epoch AND cp.position=h.position
       JOIN core.outbox anchor ON anchor.partition_no=h.partition_no AND anchor.position=i.position
         AND anchor.epoch=h.epoch AND anchor.event_seq=0
       ORDER BY i.partition FOR SHARE OF h,cp
     ), proved AS MATERIALIZED (
       SELECT h.* FROM homes h WHERE NOT EXISTS (
         SELECT 1 FROM generate_series(h.position+1,h.head) step(pos)
         LEFT JOIN LATERAL (
           SELECT epoch,type,data,event_count,payload_state,subject FROM core.outbox
           WHERE partition_no=h.partition AND position=step.pos AND event_seq=0 LIMIT 1
         ) o ON true
         WHERE (o.epoch=h.collection_epoch AND o.event_count=1 AND o.payload_state='present' AND o.subject IS NULL
           AND ((o.type=$7 AND EXISTS (
               SELECT 1 FROM (${completedLocatorSources}) delivery
               WHERE delivery.partition_no=h.partition AND delivery.epoch=h.collection_epoch
                 AND delivery.source_position=CASE WHEN pg_input_is_valid(o.data->>'position','bigint')
                       THEN (o.data->>'position')::bigint END
                 AND delivery.source_position<=h.position
                 AND o.data=jsonb_build_object('position',delivery.source_position::text)
             ))
             OR (h.partition=0 AND o.type=$8 AND o.data='{}'::jsonb AND EXISTS (
               SELECT 1 FROM LATERAL (
                 SELECT physical_target,publication_gate_from FROM search.identity_writer_gate
                 WHERE partition_no=0 AND owner_epoch=h.collection_epoch AND publication_gate_through>=step.pos
                 ORDER BY publication_gate_through LIMIT 1
               ) gate WHERE gate.physical_target<>$9 AND gate.publication_gate_from<step.pos
             )))) IS NOT TRUE
           OR EXISTS (SELECT 1 FROM core.outbox extra WHERE extra.partition_no=h.partition
                        AND extra.position=step.pos AND extra.event_seq>0)
       )
     ), locked AS MATERIALIZED (
       SELECT p.partition_no,p.owner,h.head FROM proved h JOIN search.discovery_population p
         ON p.partition_no=h.partition AND p.prefix=$1 AND p.generation=$2
         AND p.complete AND p.certified AND p.reconcile_position=h.position
       WHERE CASE p.owner
         WHEN 'accounts' THEN (p.revision,p.claim_revision)=(h.revision,h.claim_revision)
         WHEN 'semantic' THEN (p.revision,p.claim_revision)=(h.semantic_revision,h.semantic_claim_revision)
         WHEN 'collection' THEN p.native_complete AND p.native_epoch=h.collection_epoch
         WHEN 'review' THEN p.native_complete WHEN 'space' THEN p.native_complete ELSE false END
       ORDER BY p.partition_no,p.owner FOR UPDATE OF p
     ), updated AS (
       UPDATE search.discovery_population p SET reconcile_position=l.head
       FROM locked l WHERE p.prefix=$1 AND p.generation=$2 AND (p.partition_no,p.owner)=(l.partition_no,l.owner)
         AND l.partition_no IN (SELECT partition_no FROM locked GROUP BY partition_no HAVING count(*)=5)
       RETURNING p.partition_no
     ) SELECT DISTINCT partition_no AS partition FROM updated`,
    [
      prefix,
      generation,
      uuid,
      incarnation,
      JSON.stringify(cuts),
      discoveryConsumer(prefix, generation),
      SEMANTIC_LOCATOR_ADVANCED,
      SEARCH_IDENTITY_WRITER_CHANGED,
      discoveryIndexName(prefix, generation),
    ],
  );
  return new Set(result.rows.map(({ partition }) => partition));
}
