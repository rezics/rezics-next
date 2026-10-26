SELECT mode, head, selection, revision FROM semantic.adoption
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND slot_id = :slot_id::uuid AND context_id = :context_id::uuid
ORDER BY head DESC LIMIT 1;
