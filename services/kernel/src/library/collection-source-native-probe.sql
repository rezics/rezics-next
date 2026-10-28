-- Exact original seeks preserve duplicate occurrence witnesses without scanning a prior subject range.
SELECT subject_id::text AS "storedSubjectId", member_id::text AS "factId"
FROM library.collection_member
WHERE route = :route AND collection_id = :collection_id AND subject_id = :subject_id
ORDER BY member_id LIMIT 1;
