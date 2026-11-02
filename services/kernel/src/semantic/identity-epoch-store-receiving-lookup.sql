SELECT r.*,c.epoch AS native_epoch,c.position AS native_position,
 g.pending_job,g.pending_epoch,e.transaction_id AS effect_transaction_id,
 ec.epoch AS effect_epoch,ec.position AS effect_position,e.frontier
FROM semantic.identity_epoch_receiving_record r
JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
 AND c.purpose='identity-receiving-record' AND c.xmin=r.xmin AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
JOIN core.partition p ON p.partition_no=r.partition_no AND p.epoch=r.owner_epoch
 AND p.epoch=c.epoch AND p.write_state='active' AND p.position>=c.position
JOIN semantic.identity_epoch_receiving_gate g ON (g.partition_no,g.owner_id,g.original,g.owner_epoch)=
 (r.partition_no,r.owner_id,r.original,r.owner_epoch)
LEFT JOIN semantic.identity_epoch_receiving_effect e ON (e.partition_no,e.job_id,e.effect_key)=(r.partition_no,r.job_id,r.effect_key)
LEFT JOIN semantic.identity_epoch_native_commit ec ON (ec.partition_no,ec.transaction_id)=(e.partition_no,e.transaction_id)
 AND ec.purpose=r.binding->>'step' AND r.binding->>'step' IN ('library-private-follow-counts','search-canonical-index') AND ec.xmin=e.xmin AND ec.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND EXISTS (SELECT 1 FROM semantic.identity_epoch_step s
   WHERE s.partition_no=e.partition_no AND s.transaction_id=e.transaction_id
   AND s.job_id=r.job_id AND s.job_epoch=r.job_epoch AND s.step=r.binding->>'step'
   AND s.version=1 AND s.scope_digest=r.binding->>'scopeDigest' AND s.frontier=e.frontier
   AND s.native_epoch=ec.epoch AND s.native_position=ec.position AND s.xmin=ec.xmin)
WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.effect_key=$4
 AND r.original=$5 AND r.transaction_id=$6 AND c.epoch=$7 AND c.position=$8;
