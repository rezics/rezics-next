SELECT revision, state
FROM rating.question_lifecycle
WHERE question_id = :question_id::uuid;
