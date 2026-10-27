SELECT target_type AS type FROM semantic.outbound_link
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND present AND relation
  AND property = :property::text AND filter_value = :filter_value::uuid
ORDER BY order_key, target_subject_id, statement_id
LIMIT 1000;
