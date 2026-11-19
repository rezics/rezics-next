SELECT s.subject_id,(s.mapping).*,s.dirty_revision,s.captured_revision,s.current_target
FROM semantic.identity_epoch_mapping_sources($1::uuid[],$2::integer[]) s;
