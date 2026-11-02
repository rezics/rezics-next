SELECT c.epoch,c.position::text
FROM search.identity_receiving_native_operation o
JOIN semantic.identity_epoch_receiving_effect e
 ON (e.partition_no,e.job_id,e.effect_key,e.transaction_id) = (o.partition_no,$3::uuid,$5::text,o.applied_transaction_id)
JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(o.partition_no,o.applied_transaction_id)
 AND c.purpose='search-canonical-index' AND c.xmin=o.xmin AND c.xmin=e.xmin
JOIN semantic.identity_epoch_step s ON (s.partition_no,s.transaction_id)=(c.partition_no,c.transaction_id)
 AND s.job_id=e.job_id AND s.job_epoch=$4 AND s.step='search-canonical-index' AND s.version=1
 AND s.scope_digest=$6 AND s.frontier=e.frontier AND s.frontier=o.frontier
 AND s.native_epoch=c.epoch AND s.native_position=c.position AND s.xmin=c.xmin
WHERE o.partition_no=$1 AND o.plan_id=$2 AND o.state='applied'
 AND (c.xmin=pg_current_xact_id_if_assigned()::xid)=$7::boolean;
