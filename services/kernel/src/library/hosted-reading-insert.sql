WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id,
         :catalogue_id::uuid AS catalogue_id,
         :publication_revision_id::uuid AS publication_revision_id,
         :occurrence_id::uuid AS occurrence_id,
         :target_revision_id::uuid AS target_revision_id,
         decode(:target_sha256::text, 'hex') AS target_sha256,
         :document_block_id::text AS document_block_id,
         :document_offset::integer AS document_offset
)
INSERT INTO library.hosted_reading (
  route, account_id, subject_id, catalogue_id, publication_revision_id, occurrence_id,
  target_revision_id, target_sha256, document_block_id, document_offset, revision
)
SELECT route, account_id, subject_id, catalogue_id, publication_revision_id, occurrence_id,
       target_revision_id, target_sha256, document_block_id, document_offset, 1
FROM input
ON CONFLICT (route, account_id, subject_id) DO NOTHING
RETURNING revision::text AS revision,
          catalogue_id,
          publication_revision_id,
          occurrence_id,
          target_revision_id,
          encode(target_sha256, 'hex') AS target_sha256,
          document_block_id,
          document_offset;
