-- Exactly one original executor component; no UUID, current command or caller receipt substitution.
SELECT 1 FROM semantic.identity_epoch_native_commit n
JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position>=n.position
JOIN core.outbox o ON o.partition_no=n.partition_no AND o.position=n.position AND o.event_seq=0 AND o.epoch=n.epoch
WHERE n.partition_no=$1 AND n.transaction_id=$2 AND n.epoch=$3 AND n.position=$4 AND n.purpose=$5
  AND n.xmin::text=$6 AND o.xmin=n.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
  AND p.write_state='active' AND p.moved_to IS NULL
  AND $7::xid8 IS DISTINCT FROM pg_current_xact_id_if_assigned();
