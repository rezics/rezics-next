SELECT context_id::text, suppressed, property, statement_id::text AS statement, slot_id::text AS slot,
       NULLIF(target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       filter_value::text, order_key, relation, source_type, source_order_key,
       outbound_order, source_revision, source_security_revision::text, target_revision,
       target_type, external, value
FROM semantic.outbound_link
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND present
  AND (property, target_subject_id, statement_id, filter_value, context_id) >
    (:after_property::text, :after_target::uuid, :after_statement::uuid, :after_filter::uuid, :after_context::uuid)
ORDER BY property, target_subject_id, statement_id, filter_value, context_id
LIMIT 100;
