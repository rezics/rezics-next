WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :after_property::text AS after_property, :after_source::uuid AS after_source,
         :after_statement::uuid AS after_statement, :after_filter::uuid AS after_filter, :after_context::uuid AS after_context
)
SELECT link.context_id::text, link.suppressed, link.property, link.source_subject_id::text, link.statement_id::text, link.source_revision,
       link.source_security_revision::text, link.present, link.source_type, link.order_key,
       link.filter_value::text
FROM input
JOIN semantic.inbound_link AS link ON link.route = input.route AND link.subject_id = input.subject_id
WHERE link.present
AND (link.property, link.source_subject_id, link.statement_id, link.filter_value, link.context_id) >
    (input.after_property, input.after_source, input.after_statement, input.after_filter, input.after_context)
ORDER BY link.property, link.source_subject_id, link.statement_id, link.filter_value, link.context_id LIMIT 100;
