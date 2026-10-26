UPDATE semantic.subject
SET visibility = :visibility::text, security_revision = security_revision + 1
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND visibility = :expected_visibility::text AND security_revision = :expected_security_revision::bigint
RETURNING security_revision::text AS security_revision;
