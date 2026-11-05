WITH input AS MATERIALIZED (
  SELECT h.partition_no, h.owner_epoch, h.position
  FROM jsonb_to_recordset(:heads::jsonb) AS h(partition_no integer, owner_epoch integer, position bigint)
)
INSERT INTO semantic.public_filter_projection_head (build_id, partition_no, owner_epoch, position)
SELECT :build_id::uuid, input.partition_no, input.owner_epoch, input.position
FROM input
ON CONFLICT (build_id, partition_no) DO UPDATE
SET owner_epoch = EXCLUDED.owner_epoch, position = EXCLUDED.position
WHERE semantic.public_filter_projection_head.owner_epoch = EXCLUDED.owner_epoch
  AND semantic.public_filter_projection_head.position = EXCLUDED.position
RETURNING partition_no;
