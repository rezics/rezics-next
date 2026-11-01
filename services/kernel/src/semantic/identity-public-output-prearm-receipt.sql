SELECT c.epoch AS native_epoch,c.position::text AS native_position,c.transaction_id::text
FROM semantic.identity_scope_prearm_receipt r JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id) AND c.xmin=r.xmin
JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position
JOIN core.outbox o ON o.partition_no=c.partition_no AND o.epoch=c.epoch AND o.position=c.position AND o.event_seq=0
 AND o.xmin=c.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
WHERE r.partition_no=$1 AND r.source_key=$2 AND r.scope_id=$3 AND r.registration=$4 AND r.job_id=$5 AND r.job_epoch=$6
AND r.directory_transaction=$7 AND r.page_id=$8 AND r.ordinal=$9 AND r.disposition=$10
AND c.purpose=$11 AND p.write_state='active' AND p.moved_to IS NULL;
