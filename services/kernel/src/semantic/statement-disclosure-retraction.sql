SELECT revision FROM semantic.retraction
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND candidate_id = :candidate_id::uuid
ORDER BY revision DESC LIMIT 1;
