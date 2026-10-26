SELECT subject_id::text AS subject_id FROM semantic.external_claim
WHERE route = :route::integer AND source = :source::text AND external_id = :external_id::text;
