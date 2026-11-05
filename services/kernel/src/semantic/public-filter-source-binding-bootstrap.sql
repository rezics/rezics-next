SELECT b.bootstrap::text, b.read_definition::text, b.consumer, b.snapshot_kind, b.owner_epoch,
  b.source_position::text, b.state, b.account_after, b.queried,
  b.publication_job::text, b.publication_observation, b.publication_execution,
  b.coverage_generation::text, b.coverage_after, b.coverage_root, b.coverage_sealed
FROM semantic.public_filter_bootstrap b
JOIN core.partition p ON p.partition_no = b.partition_no
WHERE b.partition_no = 0 AND b.bootstrap = :bootstrap::uuid
  AND p.epoch = b.owner_epoch AND p.write_state = 'active';
