WITH input AS (
  SELECT :route::integer AS route,
         :session_id::uuid AS session_id,
         :time::timestamptz AS added_at,
         :unit_ids::text[] AS unit_ids
),
present AS (
  SELECT session.route, session.session_id
  FROM library.progress_session AS session
  CROSS JOIN input
  WHERE session.route = input.route AND session.session_id = input.session_id
),
inserted AS (
  INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)
  SELECT present.route, present.session_id, unit.unit_id, input.added_at
  FROM present
  CROSS JOIN input
  CROSS JOIN LATERAL (
    SELECT DISTINCT listed.unit_id FROM unnest(input.unit_ids) AS listed(unit_id)
  ) AS unit
  ON CONFLICT (route, session_id, unit_id) DO NOTHING
  RETURNING 1
)
SELECT count(*)::integer AS added FROM inserted;
