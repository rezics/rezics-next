INSERT INTO rating.population_vote
  (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
SELECT :route::integer, :question_id::uuid, :population_id::uuid, :target_id::uuid, :voter_id::uuid,
       :counting_key, :units::nullable(integer), :at::timestamptz, :revision::integer
WHERE NOT EXISTS (
  SELECT 1 FROM rating.population_vote_removal
  WHERE route = :route::integer AND question_id = :question_id::uuid AND population_id = :population_id::uuid
    AND target_id = :target_id::uuid AND voter_id = :voter_id::uuid AND revision >= :revision::integer
)
ON CONFLICT (route, question_id, population_id, target_id, voter_id) DO UPDATE
SET counting_key = EXCLUDED.counting_key,
    units = EXCLUDED.units,
    at = EXCLUDED.at,
    revision = EXCLUDED.revision
WHERE rating.population_vote.revision < EXCLUDED.revision
RETURNING 1;
