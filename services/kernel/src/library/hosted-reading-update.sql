WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id,
         :catalogue_id::uuid AS catalogue_id,
         :publication_revision_id::uuid AS publication_revision_id,
         :occurrence_id::uuid AS occurrence_id,
         :target_revision_id::uuid AS target_revision_id,
         decode(:target_sha256::text, 'hex') AS target_sha256,
         :document_block_id::nullable(text) AS document_block_id,
         :document_offset::nullable(integer) AS document_offset,
         :expected_revision::bigint AS expected_revision
)
UPDATE library.hosted_reading AS stored
SET catalogue_id = input.catalogue_id,
    publication_revision_id = input.publication_revision_id,
    occurrence_id = input.occurrence_id,
    target_revision_id = input.target_revision_id,
    target_sha256 = input.target_sha256,
    document_block_id = input.document_block_id,
    document_offset = input.document_offset,
    revision = stored.revision + 1,
    changed_at = clock_timestamp(),
    activity_sequence = nextval('library.hosted_reading_activity_sequence')
FROM input
WHERE stored.route = input.route
  AND stored.account_id = input.account_id
  AND stored.subject_id = input.subject_id
  AND stored.revision = input.expected_revision
  AND stored.revision < 9223372036854775807
RETURNING stored.revision::text AS revision,
          stored.catalogue_id,
          stored.publication_revision_id,
          stored.occurrence_id,
          stored.target_revision_id,
          encode(stored.target_sha256, 'hex') AS target_sha256,
          stored.document_block_id,
          stored.document_offset;
