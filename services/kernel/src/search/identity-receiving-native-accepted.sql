SELECT c.epoch,c.position::text
FROM semantic.identity_epoch_receiving_record r
JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
 AND c.purpose='identity-receiving-record' AND c.xmin=r.xmin
JOIN semantic.identity_epoch_receiving_gate g
 ON (g.partition_no,g.owner_id,g.original,g.owner_epoch)=(r.partition_no,r.owner_id,r.original,r.owner_epoch)
JOIN search.identity_receiving_native_hold h
 ON h.partition_no=r.partition_no AND h.plan_id=$11 AND h.accepted_transaction_id=r.transaction_id
 AND (h.xmin=r.xmin OR (h.released_transaction_id IS NOT NULL
   AND h.accepted_epoch=c.epoch AND h.accepted_position=c.position))
WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.effect_key=$4
 AND r.original=$5 AND r.owner_id=$6 AND r.transaction_id=$7
 AND r.binding->>'step'='search-canonical-index' AND r.binding->>'version'='1'
 AND r.binding->>'scopeDigest'=$8 AND r.binding->'source'=$9::jsonb
 AND r.source_hold->>'transactionId'=r.transaction_id::text
 AND (r.source_hold->>'partition')::integer=r.partition_no
 AND (r.source_hold->>'epoch')::integer=c.epoch
 AND (r.source_hold->>'position')::bigint=c.position
 AND ((g.pending_job=r.job_id AND g.pending_epoch=r.job_epoch)
   OR (h.released_transaction_id IS NOT NULL AND g.pending_job IS NULL AND g.pending_epoch IS NULL))
 AND r.owner_epoch=c.epoch
 AND (c.xmin=pg_current_xact_id_if_assigned()::xid)=$10::boolean;
