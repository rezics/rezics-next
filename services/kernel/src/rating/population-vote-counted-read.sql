SELECT voter_id AS "voterId", units, at::text AS at
FROM rating.population_vote
WHERE route = :route::integer AND question_id = :question_id::uuid AND population_id = :population_id::uuid
  AND target_id = :target_id::uuid AND counting_key = :counting_key AND units IS NOT NULL
ORDER BY population_vote.at DESC, population_vote.voter_id
LIMIT 1;
