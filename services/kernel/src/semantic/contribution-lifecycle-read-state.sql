SELECT state, deleted_at, purge_after, held, version::text AS security_revision
FROM semantic.record_lifecycle
WHERE route=:route::integer AND subject_id=:subject_id::uuid AND candidate_id=:candidate_id::uuid;
