-- The source owner's native locks must already be held by this command.
SELECT field.id, field.availability, field.body IS NULL AS body_is_null,
       binding.document_id IS NOT NULL AS recorded,
       (binding.subject_id = field.subject
        AND binding.candidate_id = field.candidate
        AND binding.revision = field.revision
        AND binding.deletion_generation = :deletion_generation::text
        AND binding.source_version = :source_version::text
        AND binding.deletion_transaction_id = :deletion_transaction_id::text
        AND binding.deletion_committed_at = :deletion_committed_at::timestamptz
        AND binding.purge_after = :purge_after::timestamptz) AS same_source
FROM content.authored_field AS field
LEFT JOIN content.authored_field_purge AS binding
  ON binding.route = field.route AND binding.document_id = field.id
WHERE field.route = :route::integer AND field.id = :document_id::uuid
  AND field.subject = :subject_id::uuid AND field.candidate = :candidate_id::uuid
  AND field.revision = :revision::bigint
FOR UPDATE OF field;
