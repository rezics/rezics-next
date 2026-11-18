/* semantic.native-keyed:3:3 */
SELECT d.read_definition::text
FROM core.partition p
JOIN semantic.public_filter_source s ON s.partition_no=p.partition_no AND s.owner_epoch=p.epoch
JOIN semantic.public_filter_read_definition d
  ON (d.partition_no,d.source_id,d.configuration)=(s.partition_no,s.source_id,s.configuration)
WHERE p.partition_no=0 AND p.write_state='active' AND p.epoch>0
  AND s.route_digest=:route_digest::text AND s.family='global-subject-v1'
  AND d.release_digest=:release_digest::text AND d.capture_digest=:capture_digest::text
  AND d.capture=:capture::text AND d.dependency_keys=:dependency_keys::jsonb AND d.coverage_keys=:coverage_keys::text[];
