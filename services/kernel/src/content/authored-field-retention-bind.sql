INSERT INTO content.authored_field_purge
  (route, document_id, subject_id, candidate_id, revision, deletion_generation,
   source_version, deletion_transaction_id, deletion_committed_at, purge_after)
SELECT field.route, field.id, field.subject, field.candidate, field.revision,
       :deletion_generation::text, :source_version::text, :deletion_transaction_id::text,
       :deletion_committed_at::timestamptz, :purge_after::timestamptz
FROM content.authored_field AS field
WHERE field.route = :route::integer AND field.id = :document_id::uuid
  AND field.subject = :subject_id::uuid AND field.candidate = :candidate_id::uuid
  AND field.revision = :revision::bigint AND field.availability = 'erased' AND field.body IS NULL
RETURNING document_id;
