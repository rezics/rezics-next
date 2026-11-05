WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :slot_id::uuid AS slot_id,
         :expanded::boolean AS expanded
), facts AS MATERIALIZED (
  SELECT f.statement_id FROM input JOIN semantic.fact f
    ON f.route = input.route AND f.subject_id = input.subject_id AND f.slot_id = input.slot_id
  WHERE NOT input.expanded AND f.operation = 'assert'
  ORDER BY f.log_seq FOR SHARE OF f
), candidates AS MATERIALIZED (
  SELECT c.candidate_id FROM input
  CROSS JOIN jsonb_to_recordset(:selection::jsonb) AS selected(candidate uuid)
  JOIN semantic.candidate c ON c.route = input.route AND c.subject_id = input.subject_id
    AND c.slot_id = input.slot_id AND c.candidate_id = selected.candidate
  WHERE input.expanded
  ORDER BY c.candidate_id FOR SHARE OF c
), adoption AS MATERIALIZED (
  SELECT a.head FROM input JOIN semantic.adoption a
    ON a.route = input.route AND a.subject_id = input.subject_id AND a.slot_id = input.slot_id
  WHERE input.expanded AND a.context_id = :context_id::uuid AND a.head = :head::integer
  FOR SHARE OF a
)
SELECT (SELECT count(*)::integer FROM facts) AS facts,
       (SELECT count(*)::integer FROM candidates) AS candidates,
       (SELECT count(*)::integer FROM adoption) AS adoption;
