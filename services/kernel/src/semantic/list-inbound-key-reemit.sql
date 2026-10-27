SELECT context_id::text, suppressed, property, source_subject_id::text AS source, statement_id::text AS statement,
       source_revision, source_security_revision::text, source_type, order_key, filter_value::text
FROM semantic.inbound_link AS links
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND present
  AND (property, source_subject_id, statement_id, filter_value, context_id) >
    (:after_property::text, :after_source::uuid, :after_statement::uuid, :after_filter::uuid, :after_context::uuid)
ORDER BY links.property, links.source_subject_id, links.statement_id, links.filter_value, links.context_id
LIMIT 101;
