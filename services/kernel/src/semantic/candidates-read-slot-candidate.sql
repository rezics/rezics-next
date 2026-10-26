SELECT candidate_id::text FROM semantic.candidate
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND slot_id = :slot_id::uuid AND candidate_id = :candidate_id::uuid;
