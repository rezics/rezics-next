WITH input AS (SELECT :mixed::boolean AS mixed)
INSERT INTO semantic.public_filter_bootstrap
  (partition_no, bootstrap, read_definition, request_key, consumer, snapshot_kind, native_snapshot,
   owner_epoch, source_position, state, account_after)
SELECT s.partition_no, :bootstrap::uuid, d.read_definition, :request_key::text, :consumer::text,
  :snapshot_kind::text, pg_current_snapshot(), p.epoch, p.position,
  'capturing', 0
FROM semantic.public_filter_read_definition d
JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration) =
  (d.partition_no,d.source_id,d.configuration)
JOIN core.partition p ON p.partition_no = s.partition_no
CROSS JOIN input
WHERE d.partition_no = 0 AND d.read_definition = :read_definition::uuid
  AND s.owner_epoch = p.epoch AND p.write_state = 'active'
ON CONFLICT(partition_no,request_key) WHERE state = 'capturing'
DO UPDATE SET request_key = EXCLUDED.request_key
RETURNING bootstrap::text;
