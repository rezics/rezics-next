INSERT INTO semantic.public_filter_read_definition
  (partition_no, source_id, configuration, release_digest, subject_type, capture_digest, capture, dependency_keys, coverage_keys)
SELECT s.partition_no, s.source_id, s.configuration, :release_digest::text, :subject_type::text,
  :capture_digest::text, :capture::text, :dependency_keys::jsonb, :coverage_keys::text[]
FROM semantic.public_filter_source s
JOIN core.partition p ON p.partition_no = s.partition_no
WHERE s.partition_no = 0 AND s.source_id = :source_id::uuid AND s.configuration = :configuration::uuid
  AND s.owner_epoch = p.epoch AND p.write_state = 'active' AND s.route_digest = :route_digest::text
ON CONFLICT(partition_no, source_id, configuration, release_digest, subject_type, capture_digest)
DO UPDATE SET capture_digest = EXCLUDED.capture_digest, coverage_keys = EXCLUDED.coverage_keys
WHERE public_filter_read_definition.capture = EXCLUDED.capture
  AND public_filter_read_definition.dependency_keys = EXCLUDED.dependency_keys
RETURNING read_definition::text;
