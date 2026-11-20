/* semantic.native-keyed:5:5 */
SELECT b.bootstrap::text, b.read_definition::text, b.consumer, b.snapshot_kind, b.owner_epoch,
  b.source_position::text, b.state, b.account_after, b.queried,
  (SELECT s.birth::text FROM core.subject_subscription_v1 s
   JOIN semantic.subject_source_preparation_v1 prep USING(birth) WHERE s.bootstrap=b.bootstrap) AS held_birth,
  CASE WHEN b.publication_job IS NOT NULL AND EXISTS (
    SELECT FROM search.public_filter_coverage_preparation c WHERE c.bootstrap=b.bootstrap AND c.ack_protocol=1
  ) THEN 1 ELSE 0 END AS ack_protocol, b.publication_job::text, b.publication_observation, b.publication_execution,
  b.coverage_generation::text, b.coverage_after, b.coverage_root, b.coverage_sealed, b.coverage_publication::text,
  encode(sha256(convert_to(b.book_withdrawals::text, 'UTF8')), 'hex') AS withdrawal_digest
FROM semantic.public_filter_bootstrap b
JOIN core.partition p ON p.partition_no = b.partition_no
WHERE b.partition_no = 0 AND b.bootstrap = :bootstrap::uuid
  AND p.epoch = b.owner_epoch AND p.write_state = 'active';
