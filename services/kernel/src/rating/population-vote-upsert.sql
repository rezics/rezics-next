WITH incoming AS (
  SELECT :route::integer AS route, :question_id::uuid AS question_id, :population_id::uuid AS population_id,
         :target_id::uuid AS target_id, :voter_id::uuid AS voter_id, :counting_key::text AS counting_key,
         :units::nullable(integer) AS units, :at::timestamptz AS at, :revision::integer AS revision
)
INSERT INTO rating.population_vote
  (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
SELECT incoming.route, incoming.question_id, incoming.population_id, incoming.target_id, incoming.voter_id,
       incoming.counting_key, incoming.units, incoming.at, incoming.revision
FROM incoming
WHERE NOT EXISTS (
  SELECT 1 FROM rating.population_vote_removal AS removal
  WHERE removal.route = incoming.route AND removal.question_id = incoming.question_id
    AND removal.population_id = incoming.population_id AND removal.target_id = incoming.target_id
    AND removal.voter_id = incoming.voter_id AND removal.revision >= incoming.revision
)
ON CONFLICT (route, question_id, population_id, target_id, voter_id) DO UPDATE
SET counting_key = EXCLUDED.counting_key,
    units = EXCLUDED.units,
    at = EXCLUDED.at,
    revision = EXCLUDED.revision
WHERE rating.population_vote.revision < EXCLUDED.revision
RETURNING 1;
