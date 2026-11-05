SELECT source_key, original_transaction::text AS "originalTransaction",
       original_position::text AS "originalPosition", producer_version
FROM core.record_history_locator
WHERE partition_no=:partition::integer AND source_key=:source_key::text
  AND artifact_type=:artifact_type::text AND locator=:locator::bytea
ORDER BY source_key LIMIT 2 FOR SHARE;
