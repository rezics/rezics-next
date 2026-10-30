WITH input AS (SELECT :observation::text AS observation)
UPDATE semantic.public_filter_bootstrap b
SET state = 'adopted', queried = input.observation
FROM core.partition p CROSS JOIN input
WHERE b.partition_no = 0 AND b.bootstrap = :bootstrap::uuid
  AND p.partition_no = b.partition_no AND p.epoch = b.owner_epoch AND p.write_state = 'active'
  AND (b.state = 'begun' OR (b.state = 'adopted' AND b.queried = input.observation))
RETURNING b.bootstrap::text;
