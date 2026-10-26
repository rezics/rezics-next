UPDATE semantic.subject
SET security_revision = security_revision + 1
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND security_revision = :expected_security_revision::bigint
RETURNING security_revision::text AS security_revision;
