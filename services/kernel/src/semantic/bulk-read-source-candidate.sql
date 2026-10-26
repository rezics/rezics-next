SELECT candidate_id::text AS candidate_id FROM semantic.source_candidate
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND source = :source::text
AND external_id = :external_id::text AND field_group = :field_group::text AND statement_digest = :statement_digest::text;
