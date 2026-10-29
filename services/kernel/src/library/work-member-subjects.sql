WITH RECURSIVE subjects AS (
  (SELECT subject_id, 1 AS n FROM library.collection_member
   WHERE route = :route AND collection_id = :collection_id AND subject_id > :after::uuid
   ORDER BY subject_id LIMIT 1)
  UNION ALL
  SELECT next.subject_id, subjects.n + 1
  FROM subjects
  CROSS JOIN LATERAL (
    SELECT subject_id FROM library.collection_member
    WHERE route = :route AND collection_id = :collection_id AND subject_id > subjects.subject_id
    ORDER BY subject_id LIMIT 1
  ) AS next
  WHERE subjects.n < :limit
)
SELECT subject_id AS "subjectId" FROM subjects ORDER BY subject_id;
