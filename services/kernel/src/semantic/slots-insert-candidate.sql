INSERT INTO semantic.candidate
(route, subject_id, candidate_id, slot_id, property, rank, statement, release, relation, revision, origin, view_order)
VALUES (:route::integer, :subject_id::uuid, :candidate_id::uuid, :slot_id::uuid, :property::text, :rank::text, :statement::jsonb, :release::text, :relation::boolean, :revision::integer, 'compact', :view_order::integer);
