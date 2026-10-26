SELECT value::text FROM semantic.inbound_link_count
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND property = :property::text AND filter_value = :filter_value::uuid;
