INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id,term_changes,term_support)
VALUES(:route::integer,:subject_id::uuid,:revision::integer,'terms',:release::text,
 :transaction_id::uuid,:changes::jsonb,:support::integer[]);
