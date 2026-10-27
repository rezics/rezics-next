SELECT s.subject_id::text AS id, redirect.target::text AS redirect
FROM semantic.subject AS s
LEFT JOIN LATERAL (
  SELECT r.target FROM semantic.redirect AS r
  WHERE r.route = :route::integer AND r.subject_id = :subject_id::uuid
  ORDER BY r.sequence DESC LIMIT 1
) AS redirect ON true
WHERE s.route = :route::integer AND s.subject_id = :subject_id::uuid
  AND s.visibility = 'visible';
