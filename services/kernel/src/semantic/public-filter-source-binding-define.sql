WITH active_source AS MATERIALIZED (
  SELECT s.partition_no,s.source_id,s.configuration,:release_digest::text AS release_digest,
    :capture_digest::text AS capture_digest,:capture::text AS capture,
    :dependency_keys::jsonb AS dependency_keys,:coverage_keys::text[] AS coverage_keys
  FROM semantic.public_filter_source s
  JOIN core.partition p ON p.partition_no=s.partition_no
  WHERE s.partition_no=0 AND s.source_id=:source_id::uuid AND s.configuration=:configuration::uuid
    AND s.owner_epoch=p.epoch AND p.write_state='active' AND s.route_digest=:route_digest::text
), retained AS MATERIALIZED (
  SELECT d.read_definition
  FROM active_source s
  JOIN semantic.public_filter_read_definition d
    ON (d.partition_no,d.source_id,d.configuration)=(s.partition_no,s.source_id,s.configuration)
  WHERE d.release_digest=s.release_digest AND d.capture_digest=s.capture_digest
    AND d.capture=s.capture AND d.dependency_keys=s.dependency_keys AND d.coverage_keys=s.coverage_keys
  FOR SHARE OF d
), registered AS (
  INSERT INTO semantic.public_filter_read_definition
    (partition_no,source_id,configuration,release_digest,capture_digest,capture,dependency_keys,coverage_keys)
  SELECT s.partition_no,s.source_id,s.configuration,s.release_digest,
    s.capture_digest,s.capture,s.dependency_keys,s.coverage_keys
  FROM active_source s WHERE NOT EXISTS (SELECT 1 FROM retained)
  ON CONFLICT(partition_no,source_id,configuration,release_digest,capture_digest)
  DO UPDATE SET capture_digest=EXCLUDED.capture_digest,coverage_keys=EXCLUDED.coverage_keys
  WHERE public_filter_read_definition.capture=EXCLUDED.capture
    AND public_filter_read_definition.dependency_keys=EXCLUDED.dependency_keys
  RETURNING read_definition
)
SELECT read_definition::text FROM retained
UNION ALL
SELECT read_definition::text FROM registered;
