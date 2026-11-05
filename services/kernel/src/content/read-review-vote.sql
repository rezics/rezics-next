SELECT units, revision
FROM rating.vote
WHERE route = :route::integer AND voter_id = :voter_id::uuid
  AND question_id = :question_id::uuid AND target_id = :target_id::uuid;
