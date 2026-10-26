SELECT operation FROM semantic.fact WHERE route = :route::integer AND subject_id = :subject_id::uuid AND slot_id = :slot_id::uuid
ORDER BY log_seq DESC LIMIT 1;
