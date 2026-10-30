WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :position::bigint AS position, :envelopes::integer AS envelopes
), head AS (
  SELECT core.partition.epoch AS head_epoch, core.partition.position AS head_position
  FROM core.partition, input
  WHERE core.partition.partition_no = input.partition_no
), positions AS (
  SELECT generated.position
  FROM head, input
  CROSS JOIN LATERAL generate_series(
    input.position + 1,
    LEAST(head.head_position, input.position + input.envelopes)
  ) AS generated(position)
)
SELECT
  head.head_epoch,
  positions.position,
  outbox.event_seq,
  outbox.event_count,
  outbox.epoch,
  outbox.id,
  outbox.type,
  outbox.subject,
  outbox.data,
  outbox.payload_state,
  to_char(outbox.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time
FROM head
CROSS JOIN input
LEFT JOIN positions ON true
LEFT JOIN LATERAL (
  SELECT *
  FROM core.outbox
  WHERE partition_no = input.partition_no AND position = positions.position
  ORDER BY event_seq
) AS outbox ON true
ORDER BY positions.position, outbox.event_seq;
