-- A live source anchor; no partition position is a semantic generation.
SELECT s.visibility, s.security_revision::text AS security_revision,
       CASE WHEN octet_length(s.type) <= :max_bytes::integer THEN s.type END AS type,
       s.current_release, r.revision,
       d.target::text AS redirect
FROM semantic.subject s
LEFT JOIN LATERAL (
  SELECT revision FROM semantic.revision
  WHERE route = s.route AND subject_id = s.subject_id
  ORDER BY revision DESC LIMIT 1
) r ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect
  WHERE route = s.route AND subject_id = s.subject_id
  ORDER BY sequence DESC LIMIT 1
) d ON true
WHERE s.route = :route::integer AND s.subject_id = :subject_id::uuid;
