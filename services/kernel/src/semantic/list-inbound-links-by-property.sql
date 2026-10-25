SELECT property, source_subject_id::text AS subject, statement_id::text AS statement
FROM semantic.inbound_link
WHERE route = :route::integer
  AND subject_id = :subject_id::uuid
  AND present
  AND property = :property::text
  AND (source_subject_id, statement_id) > (:after_source::uuid, :after_statement::uuid)
ORDER BY source_subject_id, statement_id
LIMIT :page_limit::integer;
