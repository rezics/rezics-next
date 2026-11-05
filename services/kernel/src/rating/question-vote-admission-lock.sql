SELECT q.id, q.revision
FROM rating.question q
WHERE q.id = :question_id::uuid
FOR SHARE OF q;
