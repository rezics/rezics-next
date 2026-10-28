-- The two mutually exclusive ranges keep the strict tuple in the index condition.
SELECT subject_id::text AS "storedSubjectId", member_id::text AS "factId"
FROM (
  (SELECT subject_id, member_id FROM library.collection_member
   WHERE $3::uuid IS NULL AND route = $1 AND collection_id = $2
   ORDER BY subject_id, member_id LIMIT $5)
  UNION ALL
  (SELECT subject_id, member_id FROM library.collection_member
   WHERE $3::uuid IS NOT NULL AND route = $1 AND collection_id = $2
     AND (subject_id, member_id) > ($3, $4::uuid)
   ORDER BY subject_id, member_id LIMIT $5)
) AS raw
ORDER BY subject_id, member_id;
