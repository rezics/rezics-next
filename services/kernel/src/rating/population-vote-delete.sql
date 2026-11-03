WITH input AS (
  SELECT :route::integer AS route, :question_id::uuid AS question_id, :population_id::uuid AS population_id,
         :target_id::uuid AS target_id, :voter_id::uuid AS voter_id, :revision::integer AS revision,
         :erasure::boolean AS erasure
), fence AS (
  INSERT INTO rating.population_vote_removal (route, question_id, population_id, target_id, voter_id, revision)
  SELECT route, question_id, population_id, target_id, voter_id, revision FROM input WHERE erasure
  ON CONFLICT (route, question_id, population_id, target_id, voter_id) DO UPDATE
    SET revision = EXCLUDED.revision
    WHERE population_vote_removal.revision < EXCLUDED.revision
  RETURNING 1
), removed AS (
  DELETE FROM rating.population_vote AS vote USING input
  WHERE vote.route = input.route AND vote.question_id = input.question_id AND vote.population_id = input.population_id
    AND vote.target_id = input.target_id AND vote.voter_id = input.voter_id AND vote.revision <= input.revision
  RETURNING 1
)
SELECT 1 FROM fence UNION SELECT 1 FROM removed;
