INSERT INTO semantic.public_filter_source(partition_no, route_digest, owner_epoch, family)
SELECT p.partition_no, :route_digest::text, p.epoch, 'global-subject-v1'
FROM core.partition p
WHERE p.partition_no = 0 AND p.write_state = 'active' AND p.epoch > 0
ON CONFLICT(partition_no, route_digest, owner_epoch, family)
DO UPDATE SET route_digest = EXCLUDED.route_digest
RETURNING source_id::text, configuration::text, owner_epoch;
