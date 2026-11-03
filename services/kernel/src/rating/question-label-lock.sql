SELECT h.revision
FROM rating.question_label_head h
JOIN rating.question q ON q.id = h.question_id
WHERE h.question_id = :question_id::uuid AND q.realm_id = :realm_id::uuid
FOR UPDATE OF h;
