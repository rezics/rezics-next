SELECT o.operation_id::text,o.hold_id::text,o.state,o.writer_token::text,o.writer_locator,
 o.writer_transaction_id::text,o.writer_position::text,o.dispatch_transaction_id::text,
 o.visible_transaction_id::text,o.visible_position::text,o.writer_evidence_digest,
 o.applied_transaction_id::text,o.frontier,
 dc.epoch AS dispatch_epoch,dc.position::text AS dispatch_position,
 vc.position::text AS visibility_component,ac.position::text AS applied_position
FROM search.identity_receiving_native_operation o
JOIN semantic.identity_epoch_native_commit dc
 ON (dc.partition_no,dc.transaction_id)=(o.partition_no,o.dispatch_transaction_id)
 AND dc.purpose='search-canonical-index' AND (o.state<>'dispatched' OR dc.xmin=o.xmin)
 AND dc.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
LEFT JOIN semantic.identity_epoch_native_commit vc
 ON (vc.partition_no,vc.transaction_id)=(o.partition_no,o.visible_transaction_id)
 AND vc.purpose='search-canonical-index' AND (o.state='applied' OR vc.xmin=o.xmin)
 AND vc.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
LEFT JOIN semantic.identity_epoch_native_commit ac
 ON (ac.partition_no,ac.transaction_id)=(o.partition_no,o.applied_transaction_id)
 AND ac.purpose='search-canonical-index' AND ac.xmin=o.xmin
 AND ac.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
WHERE o.partition_no=$1 AND o.plan_id=$2 ;
