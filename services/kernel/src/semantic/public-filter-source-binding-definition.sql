SELECT s.source_id::text, s.configuration::text, s.owner_epoch, s.route_digest,
  d.release_digest, d.subject_type, d.capture, d.dependency_keys
FROM semantic.public_filter_read_definition d
JOIN semantic.public_filter_source s ON (s.partition_no, s.source_id, s.configuration) =
  (d.partition_no, d.source_id, d.configuration)
JOIN core.partition p ON p.partition_no = s.partition_no
WHERE d.partition_no = 0 AND d.read_definition = :read_definition::uuid
  AND s.owner_epoch = p.epoch AND p.write_state = 'active';
