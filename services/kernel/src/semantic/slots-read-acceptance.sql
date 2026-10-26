SELECT head, verdict, revision FROM semantic.acceptance_current
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND context_id = :context_id::uuid AND candidate_id = :candidate_id::uuid;
