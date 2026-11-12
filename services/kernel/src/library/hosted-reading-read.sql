WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :subject_id::uuid AS subject_id
)
SELECT catalogue_id,
       publication_revision_id,
       occurrence_id,
       target_revision_id,
       encode(target_sha256, 'hex') AS target_sha256,
       document_block_id,
       document_offset,
       revision::text AS revision
FROM library.hosted_reading, input
WHERE library.hosted_reading.route = input.route
  AND library.hosted_reading.account_id = input.account_id
  AND library.hosted_reading.subject_id = input.subject_id;
