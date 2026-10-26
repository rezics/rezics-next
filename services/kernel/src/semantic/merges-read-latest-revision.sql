WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route
)
SELECT latest.revision, s.security_revision::text AS security_revision
FROM semantic.subject s
JOIN input ON true
JOIN LATERAL (
  SELECT revision FROM semantic.revision
  WHERE route = input.route AND subject_id = s.subject_id
  ORDER BY revision DESC LIMIT 1
) latest ON true
WHERE s.route = input.route AND s.subject_id = :subject_id::uuid;
