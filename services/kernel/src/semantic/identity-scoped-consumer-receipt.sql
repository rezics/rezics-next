SELECT f.native_epoch AS epoch,f.native_position::text AS position,f.transaction_id,
 f.capture_id,f.attempt,f.source_generation,f.completion_version::text,f.seal_digest
FROM semantic.identity_scope_consumer_fence f
JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id,n.epoch,n.position)=
 (f.partition_no,f.transaction_id,f.native_epoch,f.native_position)
 AND n.purpose='identity-scope-finish' AND n.xmin=f.xmin
JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
 AND p.write_state='active' AND p.moved_to IS NULL
 AND (p.position>=n.position OR (n.transaction_id=$8 AND n.position=p.position+1))
WHERE f.partition_no=$1 AND f.source_key=$2 AND f.scope_id=$3 AND f.registration=$4
 AND f.job_id=$5 AND f.job_epoch=$6 AND f.seal_digest=$7
FOR SHARE OF f,n,p;
