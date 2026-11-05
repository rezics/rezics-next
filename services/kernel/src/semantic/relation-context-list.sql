SELECT context_id::text FROM semantic.relation_context_slot
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND slot_id = :slot_id::uuid
ORDER BY context_id;
