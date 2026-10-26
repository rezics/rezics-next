SELECT property, source_subject_id::text AS subject, statement_id::text AS statement, source_type AS type
FROM semantic.inbound_link
WHERE route = :route::integer
  AND subject_id = :subject_id::uuid
  AND present
  AND filter_value = '00000000-0000-0000-0000-000000000000'
  AND (property, source_subject_id, statement_id)
    > (:after_property::text, :after_source::uuid, :after_statement::uuid)
ORDER BY property, source_subject_id, statement_id
LIMIT :page_limit::integer;
