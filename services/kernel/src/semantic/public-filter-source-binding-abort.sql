UPDATE semantic.public_filter_bootstrap b
SET state = CASE WHEN b.state = 'aborted' THEN 'aborted' ELSE 'aborting' END
FROM core.partition p
WHERE b.partition_no = 0 AND b.bootstrap = :bootstrap::uuid
  AND p.partition_no = b.partition_no AND p.epoch = b.owner_epoch AND p.write_state = 'active'
RETURNING b.state;
