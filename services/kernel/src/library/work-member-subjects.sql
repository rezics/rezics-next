SELECT DISTINCT subject_id AS "subjectId"
FROM library.collection_member
WHERE route = :route AND collection_id = :collection_id AND subject_id > :after::uuid
ORDER BY subject_id
LIMIT :limit;
