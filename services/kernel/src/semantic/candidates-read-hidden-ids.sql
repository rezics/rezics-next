SELECT candidate_id::text FROM semantic.hidden_candidate
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND candidate_id = ANY(:candidate_ids::uuid[]);
