SELECT n.source,n.obligations,n.scope_digest,n.action_digest,n.job_id::text,n.job_epoch::text,
 n.effect_key,n.transaction_id,n.initial_copy_count,
 c.epoch AS native_epoch,c.position::text AS native_position
FROM search.identity_receiving_native_plan n
JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(n.partition_no,n.transaction_id)
 AND c.purpose='search-canonical-index' AND c.xmin=n.xmin
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=c.epoch
 AND p.write_state='active' AND p.position>=c.position
WHERE n.partition_no=$1 AND n.plan_id=$2
;
