SELECT p.*,e.epoch AS export_epoch,e.position AS export_position,
 r.source_receipt,r.transaction_id AS disposition_transaction_id,
 c.epoch AS disposition_epoch,c.position AS disposition_position,
 d.job_epoch,d.scope_digest,d.attempt_transaction_id,d.released,d.owner_epoch,
 d.sealed_transaction_id
FROM semantic.identity_epoch_prearm_page p
JOIN semantic.identity_epoch_prearm_directory d USING(partition_no,job_id,generation)
JOIN semantic.identity_epoch_native_commit e ON e.partition_no=p.partition_no AND e.transaction_id=p.transaction_id AND e.xmin=p.xmin
JOIN core.partition o ON o.partition_no=p.partition_no AND o.epoch=e.epoch AND o.epoch=d.owner_epoch AND o.position>=e.position AND o.write_state='active'
LEFT JOIN semantic.identity_epoch_prearm_disposition r ON r.partition_no=p.partition_no AND r.page_id=p.page_id AND r.stage=$5
LEFT JOIN semantic.identity_epoch_native_commit c ON c.partition_no=r.partition_no AND c.transaction_id=r.transaction_id AND c.xmin=r.xmin
 AND c.epoch=o.epoch AND c.position<=o.position AND c.purpose='identity-prearm'
WHERE p.partition_no=$1 AND p.job_id=$2 AND p.generation=$3 AND p.sequence=$4;
