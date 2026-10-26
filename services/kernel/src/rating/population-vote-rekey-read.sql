SELECT counting_key AS "countingKey", units, at::text AS at, revision
FROM rating.population_vote
WHERE route = :route::integer AND question_id = :question_id::uuid AND population_id = :population_id::uuid
  AND target_id = :target_id::uuid AND voter_id = :voter_id::uuid;
