SELECT visibility, security_revision::text AS "securityRevision", type
FROM semantic.subject
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
