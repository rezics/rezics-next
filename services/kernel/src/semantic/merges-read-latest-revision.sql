SELECT latest.revision, s.security_revision::text AS security_revision
FROM semantic.subject s
JOIN LATERAL (
  SELECT revision FROM semantic.revision
  WHERE route = :route::integer AND subject_id = s.subject_id
  ORDER BY revision DESC LIMIT 1
) latest ON true
WHERE s.route = :route::integer AND s.subject_id = :subject_id::uuid;
