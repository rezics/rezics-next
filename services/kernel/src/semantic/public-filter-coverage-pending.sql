WITH input AS (
  SELECT :input_keys::text[] AS input_keys, :subjects::jsonb AS subjects
), native AS MATERIALIZED (
  SELECT l.partition_no, l.owner_epoch, l.position
  FROM semantic.public_filter_privacy_log l
  WHERE l.partition_no = :partition_no::integer
    AND l.owner_epoch = :owner_epoch::integer
    AND l.position = :position::bigint
    AND l.transaction_id = :transaction_id::uuid
), queued AS (
  INSERT INTO semantic.public_filter_privacy_pending
    (partition_no, input_key, owner_epoch, first_position, through_position, enqueue_revision)
  SELECT n.partition_no, k.input_key, n.owner_epoch, n.position, n.position, n.position
  FROM native n CROSS JOIN input i CROSS JOIN unnest(i.input_keys) AS k(input_key)
  ORDER BY k.input_key
  ON CONFLICT (partition_no, input_key) DO UPDATE SET
    owner_epoch = EXCLUDED.owner_epoch,
    through_position = EXCLUDED.through_position,
    enqueue_revision = semantic.public_filter_privacy_pending.enqueue_revision + 1,
    first_position = CASE WHEN semantic.public_filter_privacy_pending.live
      THEN semantic.public_filter_privacy_pending.first_position ELSE EXCLUDED.first_position END,
    next_first_position = CASE WHEN semantic.public_filter_privacy_pending.captured_through IS NOT NULL
      THEN coalesce(semantic.public_filter_privacy_pending.next_first_position,EXCLUDED.first_position)
      ELSE NULL END,
    live = true
  -- The home-head lock orders appends. Do not renew a captured maintenance
  -- interval/frontier when a later input arrives; its old clear must lose CAS.
  WHERE semantic.public_filter_privacy_pending.through_position < EXCLUDED.through_position
  RETURNING partition_no
), own_rows AS (
  INSERT INTO semantic.public_filter_privacy_subject
    (partition_no, route, subject_id, owner_epoch, position)
  SELECT n.partition_no, s.route, s.subject::uuid, n.owner_epoch, n.position
  FROM native n CROSS JOIN input i CROSS JOIN jsonb_to_recordset(i.subjects) AS s(route integer, subject text)
  ON CONFLICT (partition_no, subject_id) DO UPDATE SET
    owner_epoch = EXCLUDED.owner_epoch,
    position = EXCLUDED.position
  WHERE semantic.public_filter_privacy_subject.position < EXCLUDED.position
  RETURNING subject_id
)
SELECT position::text FROM native CROSS JOIN input i
WHERE (SELECT count(*) FROM queued) = cardinality(i.input_keys)
  AND (SELECT count(*) FROM own_rows) = jsonb_array_length(i.subjects);
