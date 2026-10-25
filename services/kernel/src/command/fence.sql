WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :events::jsonb AS events
),
fence AS (
  UPDATE core.partition
  SET position = position + 1
  FROM input
  WHERE core.partition.partition_no = input.partition_no AND write_state = 'active'
  RETURNING core.partition.epoch, core.partition.position
),
append AS (
  INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
  SELECT input.partition_no, fence.position, event.ordinality - 1, jsonb_array_length(input.events), fence.epoch,
         (event.value->>'id')::uuid, event.value->>'type', event.value->>'subject', event.value->'data'
  FROM input CROSS JOIN fence
  CROSS JOIN LATERAL jsonb_array_elements(input.events) WITH ORDINALITY AS event(value, ordinality)
  RETURNING partition_no
)
SELECT epoch, position FROM fence;
