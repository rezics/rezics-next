WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :consumer::text AS consumer, :envelopes::integer AS envelopes
), checkpoint AS MATERIALIZED (
  SELECT c.epoch, c.position
  FROM core.consumer_checkpoint AS c, input
  WHERE c.partition_no = input.partition_no AND c.consumer = input.consumer
  FOR UPDATE OF c SKIP LOCKED
), head AS (
  SELECT core.partition.epoch AS head_epoch, core.partition.position AS head_position
  FROM core.partition, input
  WHERE core.partition.partition_no = input.partition_no
), positions AS (
  SELECT generated.position
  FROM head, input, checkpoint
  CROSS JOIN LATERAL generate_series(
    checkpoint.position + 1,
    LEAST(head.head_position, checkpoint.position + input.envelopes)
  ) AS generated(position)
)
SELECT
  checkpoint.epoch AS checkpoint_epoch, checkpoint.position AS checkpoint_position,
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
CROSS JOIN checkpoint
CROSS JOIN input
LEFT JOIN positions ON true
LEFT JOIN LATERAL (
  SELECT *
  FROM core.outbox
  WHERE partition_no = input.partition_no AND position = positions.position
  ORDER BY event_seq
) AS outbox ON true
ORDER BY positions.position, outbox.event_seq;
