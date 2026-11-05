INSERT INTO rating.question_lifecycle(question_id, revision, state)
VALUES (:question_id::uuid, :revision::integer, :state::text)
ON CONFLICT (question_id) DO UPDATE
SET revision = EXCLUDED.revision, state = EXCLUDED.state
WHERE rating.question_lifecycle.revision = :expected_revision::integer
RETURNING revision, state;
