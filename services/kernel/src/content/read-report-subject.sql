SELECT visibility, security_revision::text AS security_revision
FROM semantic.subject
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
