-- Exact original seeks preserve duplicate occurrence witnesses without scanning a prior subject range.
SELECT subject_id::text AS "storedSubjectId", member_id::text AS "factId"
FROM library.collection_member
WHERE route = $1 AND collection_id = $2 AND subject_id = $3
ORDER BY member_id LIMIT 1;
