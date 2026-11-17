WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :consumer::text AS consumer,
    :expected_epoch::integer AS expected_epoch, :expected_epoch_is_null::boolean AS expected_epoch_is_null,
    :expected_position::bigint AS expected_position, :next_epoch::integer AS next_epoch,
    :next_position::bigint AS next_position
), advanced AS (
  UPDATE core.consumer_checkpoint AS checkpoint
  SET epoch = input.next_epoch, position = input.next_position, updated_at = now()
  FROM input
  WHERE checkpoint.partition_no = input.partition_no AND checkpoint.consumer = input.consumer
    AND ((checkpoint.epoch IS NULL AND input.expected_epoch_is_null)
      OR (checkpoint.epoch = input.expected_epoch AND NOT input.expected_epoch_is_null))
    AND checkpoint.position = input.expected_position
  RETURNING checkpoint.partition_no, checkpoint.epoch, checkpoint.position
)
SELECT advanced.position,
  COALESCE(head.write_state = 'active' AND head.epoch = advanced.epoch AND head.position = advanced.position, false)
    AS "caughtUp"
FROM advanced
LEFT JOIN core.partition AS head ON head.partition_no = advanced.partition_no;
