WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
)
SELECT s.subject_id::text AS id, redirect.target::text AS redirect
FROM semantic.subject AS s
CROSS JOIN input
LEFT JOIN LATERAL (
  SELECT r.target FROM semantic.redirect AS r
  CROSS JOIN input
  WHERE r.route = input.route AND r.subject_id = input.subject_id
  ORDER BY r.sequence DESC LIMIT 1
) AS redirect ON true
WHERE s.route = input.route AND s.subject_id = input.subject_id
  AND s.visibility = 'visible';
