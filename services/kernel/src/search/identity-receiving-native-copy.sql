SELECT o.copy_no,o.locator,o.reconciled_transaction_id::text,o.settlement,
 (c.transaction_id IS NOT NULL AND ((o.reconciled_transaction_id IS NULL AND c.xmin=o.xmin)
 OR r.transaction_id IS NOT NULL)) AS proven
FROM search.identity_receiving_native_copy o
LEFT JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(o.partition_no,o.transaction_id)
 AND c.purpose='search-canonical-index' AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
LEFT JOIN semantic.identity_epoch_native_commit r ON (r.partition_no,r.transaction_id)=(o.partition_no,o.reconciled_transaction_id)
 AND r.purpose='search-canonical-index' AND r.xmin=o.xmin AND r.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
WHERE o.partition_no=$1 AND o.plan_id=$2 AND o.copy_no=$3;
