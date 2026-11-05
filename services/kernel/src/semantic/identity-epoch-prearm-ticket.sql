SELECT p.scope,p.registration,p.capture_id,d.attempt_transaction_id,
 a.epoch AS attempt_epoch,a.position AS attempt_position
FROM semantic.identity_epoch_prearm_page p
JOIN semantic.identity_epoch_native_commit e ON e.partition_no=p.partition_no AND e.transaction_id=p.transaction_id
 AND e.xmin=p.xmin AND e.purpose='identity-prearm'
JOIN semantic.identity_epoch_prearm_directory d ON d.partition_no=p.partition_no AND d.job_id=p.job_id AND d.generation=p.generation
JOIN semantic.identity_epoch_prearm_bridge b ON b.partition_no=d.partition_no AND b.generation=d.generation
 AND b.job_id=d.job_id AND b.job_epoch=d.job_epoch AND b.scope_digest=d.scope_digest
 AND b.owner_epoch=d.owner_epoch AND b.basis_version=d.basis_version
JOIN semantic.identity_epoch_admission_attempt t ON t.partition_no=d.partition_no AND t.job_id=d.job_id
 AND t.job_epoch=d.job_epoch AND t.scope_digest=d.scope_digest
JOIN semantic.identity_epoch_admission_receipt r ON r.partition_no=d.partition_no AND r.job_id=d.job_id
 AND r.job_epoch=d.job_epoch AND r.scope_digest=d.scope_digest AND r.stage='prepared'
 AND r.transaction_id=d.attempt_transaction_id
JOIN semantic.identity_epoch_native_commit a ON a.partition_no=r.partition_no AND a.transaction_id=r.transaction_id
 AND a.epoch=r.native_epoch AND a.position=r.native_position AND a.xmin=r.xmin AND a.purpose='admission'
JOIN semantic.identity_epoch_admission_handoff h ON h.partition_no=d.partition_no AND h.job_id=d.job_id
 AND h.job_epoch=d.job_epoch AND h.scope_digest=d.scope_digest
JOIN LATERAL jsonb_to_recordset(h.inputs) i(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
 ON i.terminal=d.terminal AND i.generation=d.generation AND i.basis_version=d.basis_version AND i.owner_epoch=d.owner_epoch
JOIN semantic.identity_epoch_original m ON m.partition_no=d.partition_no AND m.generation=d.generation AND m.original=p.original
JOIN core.partition o ON o.partition_no=d.partition_no AND o.epoch=d.owner_epoch AND o.write_state='active'
 AND o.epoch=e.epoch AND o.epoch=a.epoch AND o.position>=e.position AND o.position>=a.position
WHERE p.partition_no=$1 AND p.job_id=$2 AND d.job_epoch=$3 AND p.page_id=$4
 AND e.epoch=$5 AND e.position=$6 AND e.transaction_id=$7 AND p.original IS NOT NULL AND NOT d.released;
