UPDATE semantic.statement_disclosure SET disclosed = true
WHERE route = :route::integer AND candidate_id = :candidate_id::uuid AND NOT disclosed
RETURNING subject_id::text;
