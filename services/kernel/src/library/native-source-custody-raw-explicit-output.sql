-- Only actual selected output tuples; no predicates, pins, body or eligibility filter.
SELECT subject_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",
       :publication_transaction_id::uuid::text AS "transactionId"
FROM library.collection_source_output_member
WHERE route=:route AND collection_id=:collection_id AND generation=:output_generation
  AND subject_id>:after::uuid
ORDER BY subject_id LIMIT :limit;
