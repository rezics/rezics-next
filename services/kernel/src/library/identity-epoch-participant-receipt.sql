SELECT s.transaction_id,s.native_epoch,s.native_position::text
FROM semantic.identity_epoch_step s
JOIN semantic.identity_epoch_job j
  ON j.partition_no=s.partition_no AND j.job_id=s.job_id AND j.epoch=s.job_epoch
  AND j.scope_digest=s.scope_digest AND j.state='pending'
JOIN semantic.identity_epoch_native_commit n
  ON n.partition_no=s.partition_no AND n.transaction_id=s.transaction_id
  AND n.purpose=s.step AND n.epoch=s.native_epoch AND n.position=s.native_position AND n.xmin=s.xmin
JOIN core.partition p
  ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position>=n.position
  AND p.write_state='active' AND p.moved_to IS NULL
WHERE s.partition_no=$1 AND s.job_id=$2 AND s.job_epoch=$3
  AND s.step='library-private-follow-counts' AND s.version=1 AND s.state='complete'
  AND s.frontier->'after'='["directory",16,"admitted-inputs"]'::jsonb
ORDER BY s.native_position,s.transaction_id
LIMIT 1;
