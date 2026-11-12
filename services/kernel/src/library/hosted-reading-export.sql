-- Owner-private checkpoint page for a later export format. v4 Web decoder stays frozen.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :after_id::uuid AS after_id,
         :limit::integer AS page_limit
)
SELECT subject_id::text AS key,
       subject_id,
       catalogue_id,
       publication_revision_id,
       occurrence_id,
       target_revision_id,
       encode(target_sha256, 'hex') AS target_sha256,
       document_block_id,
       document_offset,
       revision::text AS revision,
       to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS changed_at
FROM library.hosted_reading, input
WHERE library.hosted_reading.route = input.route
  AND library.hosted_reading.account_id = input.account_id
  AND library.hosted_reading.subject_id > input.after_id
ORDER BY subject_id
LIMIT (SELECT page_limit FROM input);
