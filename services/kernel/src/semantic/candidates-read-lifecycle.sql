SELECT candidate_id::text AS candidate_id, state
FROM semantic.record_lifecycle
WHERE route=:route::integer AND subject_id=:subject_id::uuid AND candidate_id=ANY(:candidate_ids::uuid[]);
