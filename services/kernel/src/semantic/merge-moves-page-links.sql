SELECT property, source_subject_id::text, statement_id::text, source_revision,
       source_security_revision::text, present
FROM semantic.inbound_link WHERE route = :route::integer AND subject_id = :subject_id::uuid AND present
AND (property, source_subject_id, statement_id) > (:after_property::text, :after_source::uuid, :after_statement::uuid)
ORDER BY property, source_subject_id, statement_id LIMIT 100;
