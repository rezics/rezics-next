-- unbound: one primary-key probe per position of the bounded local suffix.
-- A links.projected event commits with the rows it describes. None of the
-- admitted completion events is a new input to applyLinkBatch.
WITH input AS (
  SELECT $1::integer AS partition_no,$2::integer AS epoch,$3::bigint AS checkpoint,
         $4::bigint AS observed_position,$5::text[] AS admitted_kinds
)
SELECT event.type AS kind, event.data AS payload
FROM input i
JOIN core.partition home ON home.partition_no=i.partition_no AND home.epoch=i.epoch
CROSS JOIN LATERAL generate_series(i.checkpoint + 1, i.observed_position) step(position)
JOIN LATERAL (
  SELECT type, data FROM core.outbox
  WHERE partition_no = home.partition_no AND position = step.position AND event_seq = 0
    AND event_count = 1 AND epoch = home.epoch AND payload_state = 'present'
    AND subject IS NULL AND type = ANY(i.admitted_kinds) AND pg_column_size(data) <= 8192
  LIMIT 1
) event ON true
WHERE home.write_state = 'active' AND home.moved_to IS NULL AND home.position >= i.observed_position
  AND NOT EXISTS (SELECT 1 FROM core.outbox extra WHERE extra.partition_no = home.partition_no
    AND extra.position = step.position AND extra.event_seq > 0);
