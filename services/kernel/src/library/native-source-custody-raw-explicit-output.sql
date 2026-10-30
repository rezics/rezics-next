-- Only actual selected output tuples; no predicates, pins, body or eligibility filter.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,:collection_id::uuid AS collection_id,:output_generation::uuid AS generation,
         :after::nullable(uuid) AS after_key,:limit::integer AS batch_limit
)
SELECT raw.key,''::text AS tie,raw.key AS "subjectId",
       :publication_transaction_id::uuid::text AS "transactionId"
FROM input i CROSS JOIN LATERAL (
(SELECT subject_id::text AS key
FROM library.collection_source_output_member
WHERE route=i.route AND collection_id=i.collection_id AND generation=i.generation AND i.after_key IS NULL
ORDER BY subject_id LIMIT i.batch_limit)
UNION ALL
(SELECT subject_id::text AS key
FROM library.collection_source_output_member
WHERE route=i.route AND collection_id=i.collection_id AND generation=i.generation AND i.after_key IS NOT NULL
  AND subject_id>i.after_key
ORDER BY subject_id LIMIT i.batch_limit)
) raw ORDER BY raw.key COLLATE "C";
