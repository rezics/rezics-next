WITH input AS (SELECT $9::text AS state)
SELECT d.partition_no,d.job_id,d.job_epoch,d.generation,d.terminal,d.basis_version,d.owner_epoch,d.scope_digest,
 d.attempt_transaction_id,d.sequence,d.sealed_transaction_id,d.cancel_sequence,d.cancelled_transaction_id,
 d.release_transaction_id,r.epoch AS release_epoch,r.position AS release_position,
 a.epoch AS attempt_epoch,a.position AS attempt_position,
 s.epoch AS seal_epoch,s.position AS seal_position,
 e.page_id AS final_page_id,e.transaction_id AS final_export_transaction_id,
 x.epoch AS final_export_epoch,x.position AS final_export_position,
 o.node,o.epoch AS current_epoch
FROM semantic.identity_epoch_prearm_directory d
JOIN semantic.identity_epoch_native_commit r ON r.partition_no=d.partition_no
 AND r.transaction_id=d.release_transaction_id AND r.purpose='identity-prearm-release' AND r.xmin=d.xmin
JOIN semantic.identity_epoch_admission_attempt t ON t.partition_no=d.partition_no AND t.job_id=d.job_id
 AND t.job_epoch=d.job_epoch AND t.scope_digest=d.scope_digest
JOIN semantic.identity_epoch_admission_receipt b ON b.partition_no=d.partition_no AND b.job_id=d.job_id
 AND b.job_epoch=d.job_epoch AND b.scope_digest=d.scope_digest AND b.stage='prepared'
 AND b.transaction_id=d.attempt_transaction_id
JOIN semantic.identity_epoch_native_commit a ON a.partition_no=b.partition_no AND a.transaction_id=b.transaction_id
 AND a.epoch=b.native_epoch AND a.position=b.native_position AND a.xmin=b.xmin AND a.purpose='admission'
JOIN semantic.identity_epoch_admission_handoff h ON h.partition_no=d.partition_no AND h.job_id=d.job_id
 AND h.job_epoch=d.job_epoch AND h.scope_digest=d.scope_digest AND h.job_home=$10 AND h.source_transaction_id=$11
JOIN semantic.identity_epoch_prearm_page e ON e.partition_no=d.partition_no AND e.job_id=d.job_id
 AND e.generation=d.generation AND e.sequence=d.sequence AND e.original IS NULL
JOIN semantic.identity_epoch_native_commit x ON x.partition_no=e.partition_no AND x.transaction_id=e.transaction_id
 AND x.xmin=e.xmin AND x.purpose IN ('admission','identity-prearm')
JOIN semantic.identity_epoch_prearm_disposition v ON v.partition_no=e.partition_no AND v.page_id=e.page_id
 AND v.stage='unsafe' AND v.transaction_id=d.sealed_transaction_id AND v.source_receipt IS NULL
JOIN semantic.identity_epoch_native_commit s ON s.partition_no=v.partition_no AND s.transaction_id=v.transaction_id
 AND s.xmin=v.xmin AND s.purpose IN ('admission','identity-prearm')
LEFT JOIN semantic.identity_epoch_native_commit k ON k.partition_no=d.partition_no
 AND k.transaction_id=d.cancelled_transaction_id AND k.purpose='identity-prearm'
JOIN core.partition o ON o.partition_no=d.partition_no AND o.write_state='active' AND o.moved_to IS NULL
 AND o.epoch=d.owner_epoch AND o.epoch=r.epoch AND o.epoch=a.epoch AND o.epoch=s.epoch AND o.epoch=x.epoch
 AND r.position>=a.position AND r.position>=s.position AND r.position>=x.position
 AND o.position>=r.position AND o.position>=a.position AND o.position>=s.position AND o.position>=x.position
WHERE d.partition_no=$1 AND d.job_id=$2 AND d.job_epoch=$3 AND d.generation=$4
 AND d.terminal=$5 AND d.basis_version=$6 AND d.owner_epoch=$7 AND d.scope_digest=$8
 AND d.released AND d.exhausted AND d.sequence>0
 AND jsonb_array_length(h.inputs) BETWEEN 1 AND 2
 AND EXISTS(SELECT 1 FROM jsonb_to_recordset(h.inputs)
  i(terminal uuid,generation uuid,basis_version bigint,owner_epoch integer)
  WHERE i.terminal=d.terminal AND i.generation=d.generation AND i.basis_version=d.basis_version AND i.owner_epoch=d.owner_epoch)
 AND (((SELECT state FROM input)='published' AND t.state='acquired') OR
 ((SELECT state FROM input) IN ('cancelling','cancelled') AND t.state='closed' AND d.cancel_sequence=d.sequence
  AND k.epoch=o.epoch AND k.position<=r.position));
