WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
    :thread_route::integer AS thread_route,
    :thread_id::uuid AS thread_id,
    :place_id::uuid AS place_id,
    :kind::text AS kind,
    :subject_ids::uuid[] AS subject_ids,
    :previous_subject_ids::uuid[] AS previous_subject_ids,
    :activity_at::timestamptz AS activity_at,
    :source_epoch::integer AS source_epoch,
    :source_position::bigint AS source_position
), removed AS (
  DELETE FROM content.subject_thread AS indexed
  USING input CROSS JOIN LATERAL unnest(input.previous_subject_ids) AS subjects(subject_id)
  WHERE indexed.route = input.route
    AND indexed.subject_id = subjects.subject_id
    AND NOT subjects.subject_id = ANY(input.subject_ids)
    AND indexed.thread_route = input.thread_route
    AND indexed.thread_id = input.thread_id
    AND ROW(indexed.source_epoch, indexed.source_position) < ROW(input.source_epoch, input.source_position)
  RETURNING 1
), written AS (
  INSERT INTO content.subject_thread AS indexed
    (route, subject_id, thread_route, thread_id, place_id, kind, last_activity_at, source_epoch, source_position)
  SELECT input.route,
    subjects.subject_id, input.thread_route, input.thread_id, input.place_id, input.kind,
    input.activity_at, input.source_epoch, input.source_position
  FROM input CROSS JOIN LATERAL unnest(input.subject_ids) AS subjects(subject_id)
  ON CONFLICT (route, subject_id, thread_id) DO UPDATE
  SET place_id = EXCLUDED.place_id,
    kind = EXCLUDED.kind,
    last_activity_at = GREATEST(indexed.last_activity_at, EXCLUDED.last_activity_at),
    source_epoch = EXCLUDED.source_epoch,
    source_position = EXCLUDED.source_position
  WHERE ROW(indexed.source_epoch, indexed.source_position) < ROW(EXCLUDED.source_epoch, EXCLUDED.source_position)
  RETURNING 1
)
SELECT (SELECT count(*) FROM removed) + (SELECT count(*) FROM written) AS changed;
