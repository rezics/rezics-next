WITH fence AS (
  INSERT INTO rating.population_vote_removal (route, question_id, population_id, target_id, voter_id, revision)
  SELECT :route::integer, :question_id::uuid, :population_id::uuid, :target_id::uuid,
         :voter_id::uuid, :revision::integer
  WHERE :erasure::boolean
  ON CONFLICT (route, question_id, population_id, target_id, voter_id) DO UPDATE
    SET revision = EXCLUDED.revision
    WHERE population_vote_removal.revision < EXCLUDED.revision
  RETURNING 1
), removed AS (
  DELETE FROM rating.population_vote
  WHERE route = :route::integer AND question_id = :question_id::uuid AND population_id = :population_id::uuid
    AND target_id = :target_id::uuid AND voter_id = :voter_id::uuid AND revision <= :revision::integer
  RETURNING 1
)
SELECT 1 FROM fence UNION SELECT 1 FROM removed;
