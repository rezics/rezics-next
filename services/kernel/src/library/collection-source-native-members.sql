-- The two mutually exclusive ranges keep the strict tuple in the index condition.
SELECT subject_id::text AS "storedSubjectId", member_id::text AS "factId"
FROM (
  (SELECT subject_id, member_id FROM library.collection_member
   WHERE :after_subject::uuid IS NULL AND route = :route AND collection_id = :collection_id
   ORDER BY subject_id, member_id LIMIT :limit)
  UNION ALL
  (SELECT subject_id, member_id FROM library.collection_member
   WHERE :after_subject::uuid IS NOT NULL AND route = :route AND collection_id = :collection_id
     AND (subject_id, member_id) > (:after_subject, :after_fact::uuid)
   ORDER BY subject_id, member_id LIMIT :limit)
) AS raw
ORDER BY subject_id, member_id;
