-- The statement probe is a preparation hint. The detail snapshot decides whether it needs an audience.
SELECT s.visibility, s.security_revision::text AS security_revision, NOT EXISTS (
  SELECT 1 FROM semantic.fact f
  WHERE f.route = s.route AND f.subject_id = s.subject_id AND f.kind = 'statement'
) AS no_statements
FROM semantic.subject s
WHERE s.route = :route::integer AND s.subject_id = :subject_id::uuid;
