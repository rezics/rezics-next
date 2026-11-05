-- Exact current native admission and its <=2 saved inputs, on the SAME Source/control client.
-- Locks include the prearm bridge/directory: late registration/rearming invalidates retained currentness.
WITH admitted AS MATERIALIZED (
 SELECT j.partition_no,j.job_id,j.epoch,j.recorded_transaction_id,j.scope_digest,j.prearm_transaction_id,h.transaction_id AS claim_transaction_id
 FROM semantic.identity_epoch_job j
 JOIN semantic.identity_epoch_prearm_claim h ON (h.partition_no,h.job_id,h.job_epoch)=(j.partition_no,j.job_id,j.epoch)
  AND h.scope_digest=j.scope_digest
 JOIN semantic.identity_epoch_native_commit c
  ON (c.partition_no,c.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND c.purpose='admission'
 JOIN core.partition p ON p.partition_no=j.partition_no AND p.epoch=c.epoch
  AND p.position>=c.position AND p.write_state='active' AND p.moved_to IS NULL
 WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='pending'
  AND j.prearm_phase='claiming' AND j.prearm_transaction_id IS NOT NULL
  AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 FOR SHARE OF j,h
), inputs AS MATERIALIZED (
 SELECT i.* FROM semantic.identity_epoch_input i JOIN admitted j USING(partition_no,job_id)
 ORDER BY i.terminal LIMIT 3 FOR SHARE OF i
), fences AS MATERIALIZED (
 SELECT i.terminal,jsonb_build_array(i.generation,i.basis_version,i.owner_epoch,i.prearm_sequence,
   i.prearm_transaction_id,i.prearm_epoch,i.prearm_position,b.bridge_version,d.sequence,
   d.sealed_transaction_id,d.released,d.release_transaction_id,d.cancel_sequence,d.cancelled_transaction_id) AS fence
 FROM inputs i
 JOIN admitted j USING(partition_no,job_id)
 JOIN semantic.identity_epoch_group g ON (g.partition_no,g.terminal)=(i.control_partition,i.terminal)
  AND g.generation=i.generation AND g.version=i.basis_version AND g.owner_epoch=i.owner_epoch
  AND g.pending_job=j.job_id AND g.pending_epoch=j.epoch
 JOIN semantic.identity_epoch_prearm_bridge b ON b.partition_no=g.partition_no AND b.generation=g.generation
  AND b.job_id=j.job_id AND b.job_epoch=j.epoch AND b.scope_digest=j.scope_digest
  AND b.terminal=i.terminal AND b.basis_version=i.basis_version AND b.owner_epoch=i.owner_epoch
 JOIN semantic.identity_epoch_prearm_directory d ON d.partition_no=g.partition_no AND d.generation=g.generation
  AND d.job_id=j.job_id AND d.job_epoch=j.epoch AND d.scope_digest=j.scope_digest
  AND d.terminal=i.terminal AND d.basis_version=i.basis_version AND d.owner_epoch=i.owner_epoch
 WHERE i.control_partition=j.partition_no AND i.prearm_transaction_id IS NOT NULL
  AND d.exhausted AND d.sealed_transaction_id IS NOT NULL AND d.sequence=i.prearm_sequence
  AND NOT d.released AND d.release_transaction_id IS NULL AND d.cancel_sequence=0
  AND d.cancelled_transaction_id IS NULL AND i.prearm_cancelled_transaction_id IS NULL
 FOR SHARE OF g,b,d
)
SELECT j.recorded_transaction_id::text AS transaction_id,
 CASE WHEN j.scope_digest ~ '^[0-9a-f]{64}$' THEN j.scope_digest ELSE NULL END AS scope_digest,
 jsonb_build_array(j.prearm_transaction_id,j.claim_transaction_id,(SELECT jsonb_agg(f.fence ORDER BY f.terminal) FROM fences f)) AS writer_fence
FROM admitted j
WHERE (SELECT count(*) FROM inputs) BETWEEN 1 AND 2
 AND (SELECT count(*) FROM fences)=(SELECT count(*) FROM inputs);
