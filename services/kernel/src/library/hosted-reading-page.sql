WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :after_sequence::nullable(bigint) AS after_sequence,
         :after_subject_id::nullable(uuid) AS after_subject_id,
         :limit::integer AS page_limit
)
SELECT subject_id,
       catalogue_id,
       publication_revision_id,
       occurrence_id,
       target_revision_id,
       encode(target_sha256, 'hex') AS target_sha256,
       document_block_id,
       document_offset,
       revision::text AS revision,
       activity_sequence::text AS activity_sequence,
       to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_at
FROM library.hosted_reading, input
WHERE library.hosted_reading.route = input.route
  AND library.hosted_reading.account_id = input.account_id
  AND (
    input.after_sequence IS NULL
    OR library.hosted_reading.activity_sequence < input.after_sequence
    OR (
      library.hosted_reading.activity_sequence = input.after_sequence
      AND library.hosted_reading.subject_id > input.after_subject_id
    )
  )
ORDER BY activity_sequence DESC, subject_id ASC
LIMIT (SELECT page_limit FROM input);
