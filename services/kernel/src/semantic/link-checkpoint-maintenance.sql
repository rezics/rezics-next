-- unbound: one primary-key probe per position of the bounded local suffix.
-- A links.projected event commits with the rows it describes. None of the
-- admitted completion events is a new input to applyLinkBatch.
SELECT event.type AS kind, event.data AS payload
FROM core.partition home
CROSS JOIN generate_series($3::bigint + 1, $4::bigint) step(position)
JOIN LATERAL (
  SELECT type, data FROM core.outbox
  WHERE partition_no = $1::integer AND position = step.position AND event_seq = 0
    AND event_count = 1 AND epoch = $2::integer AND payload_state = 'present'
    AND subject IS NULL AND type = ANY($5::text[]) AND pg_column_size(data) <= 8192
  LIMIT 1
) event ON true
WHERE home.partition_no = $1 AND home.epoch = $2 AND home.write_state = 'active'
  AND home.moved_to IS NULL AND home.position >= $4
  AND NOT EXISTS (SELECT 1 FROM core.outbox extra WHERE extra.partition_no = $1
    AND extra.position = step.position AND extra.event_seq > 0);
