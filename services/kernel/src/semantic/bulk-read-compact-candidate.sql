SELECT 1 AS present FROM semantic.fact WHERE route = :route::integer AND subject_id = :subject_id::uuid
AND statement_id = :candidate_id::uuid
AND kind = 'statement' AND operation = 'assert' AND statement_id IS NOT NULL LIMIT 1;
