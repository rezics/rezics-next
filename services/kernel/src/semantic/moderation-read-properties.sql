SELECT DISTINCT property FROM semantic.fact
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND kind = 'statement' AND property IS NOT NULL;
