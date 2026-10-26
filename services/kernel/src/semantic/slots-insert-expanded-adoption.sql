INSERT INTO semantic.adoption (route, subject_id, slot_id, context_id, head, mode, selection, revision)
VALUES (:route::integer, :subject_id::uuid, :slot_id::uuid, :context_id::uuid, :head::integer, :mode::text, :selection::jsonb, :revision::integer);
