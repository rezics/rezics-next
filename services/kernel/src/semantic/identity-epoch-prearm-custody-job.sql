SELECT j.job_id,j.epoch,j.scope_digest,j.state,j.receipt_key,j.receipt,j.intent,
 j.recorded_transaction_id,j.prearm_transaction_id,j.cancellation_transaction_id,
 n.epoch AS original_epoch,n.position AS original_position,
 s.transaction_id AS seal_transaction_id,c.epoch AS seal_epoch,c.position AS seal_position,
 k.epoch AS cancellation_epoch,k.position AS cancellation_position,
 p.node,p.epoch AS current_epoch
FROM semantic.identity_epoch_job j
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=j.partition_no
 AND n.transaction_id=j.recorded_transaction_id AND n.purpose='admission'
JOIN semantic.identity_epoch_prearm_decision s ON s.partition_no=j.partition_no AND s.job_id=j.job_id
 AND s.job_epoch=j.epoch AND s.scope_digest=j.scope_digest AND s.stage='sealed'
JOIN semantic.identity_epoch_native_commit c ON c.partition_no=s.partition_no
 AND c.transaction_id=s.transaction_id AND c.transaction_id=j.prearm_transaction_id AND c.xmin=s.xmin
 AND c.purpose IN ('admission','identity-prearm')
LEFT JOIN semantic.identity_epoch_prearm_decision z ON z.partition_no=j.partition_no AND z.job_id=j.job_id
 AND z.job_epoch=j.epoch AND z.scope_digest=j.scope_digest AND z.stage='cancelled'
LEFT JOIN semantic.identity_epoch_native_commit k ON k.partition_no=z.partition_no
 AND k.transaction_id=z.transaction_id AND k.transaction_id=j.cancellation_transaction_id
 AND k.xmin=z.xmin AND k.purpose='identity-prearm-cancel'
JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active' AND p.moved_to IS NULL
 AND p.epoch=n.epoch AND p.epoch=c.epoch AND p.position>=n.position AND p.position>=c.position
JOIN semantic.identity_epoch_control t ON t.partition_no=j.partition_no
WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3
 AND ((j.state='published' AND t.published_epoch>=j.epoch AND t.pending_job IS DISTINCT FROM j.job_id)
 OR (j.state IN ('cancelling','cancelled') AND k.epoch=p.epoch AND k.position<=p.position));
