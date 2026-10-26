SELECT property, source_subject_id::text AS subject, statement_id::text AS statement, source_type AS type, order_key
FROM semantic.inbound_link
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND present
  AND property = :property::text AND filter_value = :filter_value::uuid
  AND (order_key, source_subject_id, statement_id) > (:after_order::text COLLATE "C", :after_source::uuid, :after_statement::uuid)
ORDER BY order_key, source_subject_id, statement_id
LIMIT :page_limit::integer;
