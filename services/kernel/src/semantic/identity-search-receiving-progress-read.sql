SELECT p.revision,p.after_key,p.state,p.applied_transaction_id
FROM semantic.identity_epoch_receiving_search_progress p
LEFT JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(p.partition_no,p.released_transaction_id)
 AND c.purpose='identity-receiving-custody' AND c.xmin=p.xmin
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
WHERE p.partition_no=$1 AND p.job_id=$2 AND p.effect_key=$3
 AND p.accepted_transaction_id=$4 AND p.binding_digest=$5
 AND (p.state<>'released' OR c.transaction_id IS NOT NULL)
FOR UPDATE OF p;
