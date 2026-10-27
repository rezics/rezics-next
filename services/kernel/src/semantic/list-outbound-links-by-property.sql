SELECT property, statement_id::text AS statement, slot_id::text AS slot,
       NULLIF(target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       target_type AS type, external, value, order_key
FROM semantic.outbound_link
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND present AND relation
  AND property = :property::text AND filter_value = :filter_value::uuid
  AND (order_key, target_subject_id, statement_id) >
    (:after_order::text COLLATE "C", :after_target::uuid, :after_statement::uuid)
ORDER BY order_key, target_subject_id, statement_id
LIMIT :page_limit::integer;
