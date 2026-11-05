-- One exact receiving key locates the original receipt. Shared lookup validates its binding and gates.
SELECT c.transaction_id,c.epoch,c.position::text AS position
FROM semantic.identity_epoch_receiving_record r
JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
 AND c.purpose='identity-receiving-record' AND c.xmin=r.xmin
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.effect_key=$4
 AND r.original=$5 AND r.owner_id=$6;
