SELECT r.source FROM semantic.candidate c JOIN semantic.revision r
ON r.route = c.route AND r.subject_id = c.subject_id AND r.revision = c.revision
WHERE c.route = :route::integer AND c.subject_id = :subject_id::uuid AND c.candidate_id = :candidate_id::uuid;
