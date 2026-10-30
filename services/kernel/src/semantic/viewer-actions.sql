-- Native subject public evidence: exact full keys, no fact, ACL or revision history.
SELECT s.subject_id::text AS id, s.type, s.visibility,
       s.security_revision::text AS security_revision
FROM unnest(:routes::integer[], :ids::uuid[]) AS wanted(route, id)
JOIN LATERAL (
  SELECT subject_id, type, visibility, security_revision
  FROM semantic.subject
  WHERE route = wanted.route AND subject_id = wanted.id
  ORDER BY route, subject_id
  LIMIT 1
) s ON true;
