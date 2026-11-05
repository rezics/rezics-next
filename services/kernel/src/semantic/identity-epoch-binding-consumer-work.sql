-- An exact retained Source obligation supplies original provenance, never closure.
WITH parameters AS (SELECT $3::text AS digest)
SELECT c.generation::text AS replay_generation,b.consumer_undo_generation::text AS undo_generation,
 n.epoch::text AS restore_generation,c.scope_digest,c.job_home
FROM semantic.identity_epoch_receipt_binding b
JOIN semantic.identity_epoch_receipt_claim c USING(partition_no,receipt_key,generation)
JOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no
 AND n.transaction_id=k.transaction_id AND n.purpose='admission' AND n.xmin=k.xmin
 AND c.transaction_id=k.transaction_id AND c.xmin=k.xmin
JOIN semantic.identity_epoch_native_commit u ON u.partition_no=b.partition_no
 AND u.transaction_id=b.consumer_undo_transaction_id AND u.purpose='admission'
JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=b.partition_no
 AND r.receipt_key=b.receipt_key AND r.binding_generation=b.generation
 AND r.binding_transaction_id=k.transaction_id AND r.source_digest=b.intent_digest
 AND r.job_id=c.job_id AND r.job_epoch=c.job_epoch AND r.scope_digest=c.scope_digest
JOIN semantic.erasure_source_commit retained ON retained.partition_no=r.partition_no
 AND retained.transaction_id=r.transaction_id AND retained.epoch=r.owner_epoch AND retained.xmin=r.xmin
JOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active' AND p.moved_to IS NULL
 AND p.epoch=n.epoch AND p.position>=n.position AND p.epoch=u.epoch AND p.position>=u.position
 AND p.epoch=retained.epoch AND p.position>=retained.position
WHERE b.partition_no=$1 AND b.receipt_key=$2
 AND b.intent_digest=(SELECT digest FROM parameters) AND c.intent_digest=(SELECT digest FROM parameters)
 AND b.state='accepted' AND b.accepted_job=c.job_id AND b.accepted_epoch=c.job_epoch
 AND c.job_id=$4 AND c.job_epoch=$5 AND c.receipt=$6::jsonb
 AND r.source_epoch=$7 AND r.source_position=$8 AND r.source_transaction_id=$9
 AND r.barrier_account_id=$10 AND r.barrier_account_route=$11 AND r.barrier_version=$12
 AND r.barrier_at=$13::timestamptz AND r.erased_role=$14
 AND b.consumer_undo_generation IS NOT NULL AND b.consumer_terminal_custody IS NULL
 AND semantic.identity_source_consumer_terminal_hook_installed();
