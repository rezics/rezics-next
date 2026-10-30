-- The tuple fence precedes LIMIT. No private input or predicate is read here.
SELECT subject_id::text AS "storedSubjectId", subject_id::text AS "factId"
FROM library.collection_source_output_member
WHERE route=$1 AND collection_id=$2 AND generation=$3
  AND subject_id > $4::uuid
ORDER BY subject_id LIMIT $5;
