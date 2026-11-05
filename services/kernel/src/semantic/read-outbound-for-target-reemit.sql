WITH links AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset(:links::jsonb) AS link(
    context_id uuid, subject_id uuid, property text, statement_id uuid, filter_value uuid
  )
)
SELECT outbound.context_id::text, outbound.suppressed, outbound.route, outbound.subject_id::text, outbound.property,
       outbound.filter_value::text, outbound.order_key,
       NULLIF(outbound.target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       outbound.statement_id::text, outbound.slot_id::text, outbound.relation,
       outbound.source_type, outbound.source_order_key, outbound.outbound_order,
       outbound.source_revision, outbound.source_security_revision::text,
       outbound.target_revision, outbound.target_type, outbound.external, outbound.value
FROM links
JOIN LATERAL (
  SELECT * FROM semantic.outbound_link outbound
  WHERE outbound.route = :route::integer AND outbound.subject_id = links.subject_id AND outbound.context_id = links.context_id AND outbound.property = links.property
    AND outbound.statement_id = links.statement_id AND outbound.filter_value = links.filter_value
    AND outbound.present AND outbound.relation
  LIMIT 1
) outbound ON true
ORDER BY outbound.route, outbound.subject_id, outbound.property, outbound.statement_id, outbound.filter_value;
