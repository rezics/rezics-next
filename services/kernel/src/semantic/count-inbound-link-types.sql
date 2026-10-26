SELECT source_type AS type FROM semantic.inbound_link
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND present
  AND property = :property::text AND filter_value = :filter_value::uuid
ORDER BY order_key, source_subject_id, statement_id LIMIT 1000;
