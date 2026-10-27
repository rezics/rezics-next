WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON (property, filter_value, statement_id)
         route, subject_id, property, filter_value, order_key, target_subject_id,
         statement_id, slot_id, relation, source_type, source_order_key, outbound_order,
         source_revision, source_security_revision, target_revision, target_type, external, value, present
  FROM semantic.outbound_link
  WHERE route = :route::integer AND subject_id = :subject_id::uuid
  ORDER BY property, filter_value, statement_id, source_revision DESC,
           source_security_revision DESC, target_revision DESC, recorded_transaction_id DESC, order_key DESC
)
SELECT property, statement_id::text AS statement, slot_id::text AS slot,
       NULLIF(target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       filter_value::text, order_key, relation, source_type, source_order_key,
       outbound_order, source_revision, source_security_revision::text, target_revision,
       target_type, external, value
FROM latest
WHERE (:visible::boolean OR present)
  AND (property, target_subject_id, statement_id, filter_value) >
    (:after_property::text, :after_target::uuid, :after_statement::uuid, :after_filter::uuid)
ORDER BY property, target_subject_id, statement_id, filter_value
LIMIT 101;
