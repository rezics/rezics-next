INSERT INTO semantic.relation_context_slot(route, subject_id, slot_id, context_id)
VALUES (:route::integer, :subject_id::uuid, :slot_id::uuid, :context_id::uuid)
ON CONFLICT DO NOTHING;
